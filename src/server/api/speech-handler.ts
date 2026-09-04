/**
 * Framework-agnostic speech API handler. Next route files are thin wrappers,
 * which keeps the handler unit-testable without a running server.
 *
 * Guarantees:
 * - input validated with zod; text length capped; body size capped;
 * - provider pacing/retries handled inside the provider wrapper;
 * - responses never contain stack traces, provider keys or provider error
 *   bodies — only stable error codes.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { SpeechError, type SpeechProvider } from "@/domain/speech/types";
import { isValidEdgeVoice } from "@/adapters/speech-providers/edge-provider";
import { computeAudioCacheKey } from "@/infrastructure/cache/cache-key";
import { FileAudioCache } from "@/infrastructure/cache/file-audio-cache";
import { contentFingerprint, type Logger } from "@/infrastructure/logging/logger";
import type { EngineRuntime, ServerConfig } from "../config";
import { SlidingWindowRateLimiter } from "../rate-limit";

export const SpeechRequestSchema = z.object({
  text: z.string().min(1).max(10_000),
  voice: z.string().min(1).max(64).optional(),
  speed: z.number().min(0.5).max(2).optional(),
  format: z.enum(["mp3", "wav", "opus", "flac"]).optional(),
  /** Selectable synthesis engine (opaque id; "default" is always present). */
  engine: z.string().min(1).max(32).optional(),
});

export type SpeechRequestBody = z.infer<typeof SpeechRequestSchema>;

export interface HandlerDeps {
  config: ServerConfig;
  provider: SpeechProvider;
  /** Engine registry; `provider` must be the provider of the first entry.
   * When omitted, every request is served by `provider` (legacy behavior). */
  engines?: EngineRuntime[];
  cache: FileAudioCache;
  limiter: SlidingWindowRateLimiter;
  logger: Logger;
}

export interface HandlerResponse {
  status: number;
  headers: Record<string, string>;
  /** JSON body, or raw audio bytes. */
  body?: unknown;
  audio?: Uint8Array;
}

export function parseSpeechRequest(raw: unknown): SpeechRequestBody {
  return SpeechRequestSchema.parse(raw);
}

/**
 * Map a client-facing engine id to its server runtime. Unknown ids fall back
 * to the default engine (a stale tab with a removed engine must keep working);
 * with no registry configured, the legacy single-provider behavior is
 * reproduced exactly so existing deployments and tests are unaffected.
 */
export function resolveEngine(
  deps: HandlerDeps,
  requested: string | undefined,
): { engine: EngineRuntime; fellBack: boolean } {
  const id = requested ?? "default";
  if (!deps.engines) {
    const isNan = deps.config.SPEECH_PROVIDER === "nan";
    return {
      engine: {
        id: "default",
        label: "Estándar",
        provider: deps.provider,
        model: isNan ? deps.config.NAN_TTS_MODEL : "mock-v1",
        defaultVoice: isNan ? deps.config.NAN_TTS_VOICE : "mock",
        format: isNan ? deps.config.NAN_TTS_FORMAT : "wav",
      },
      fellBack: false,
    };
  }
  const found = deps.engines.find((e) => e.id === id);
  if (found) return { engine: found, fellBack: false };
  return { engine: deps.engines[0], fellBack: true };
}

export async function handleSpeech(
  raw: unknown,
  clientKey: string,
  deps: HandlerDeps,
  signal?: AbortSignal,
): Promise<HandlerResponse> {
  const started = Date.now();
  const parsed = SpeechRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return json(400, { error: "invalid_request" }, { "cache-status": "none" });
  }
  const { text } = parsed.data;
  if (text.length > deps.config.SPEECH_MAX_TEXT_CHARS) {
    return json(413, { error: "too_large" }, { "cache-status": "none" });
  }
  const retryAfter = deps.limiter.check(clientKey);
  if (retryAfter !== null) {
    return json(
      429,
      { error: "rate_limited" },
      { "cache-status": "none", "retry-after": String(retryAfter) },
    );
  }

  const { engine } = resolveEngine(deps, parsed.data.engine);
  const requestedVoice = parsed.data.voice;
  // Edge voices land inside an SSML attribute server-side; reject anything but
  // the known neural pattern rather than trusting the browser's catalog.
  const voice =
    engine.provider.name === "edge" && requestedVoice && !isValidEdgeVoice(requestedVoice)
      ? undefined
      : requestedVoice;
  if (
    engine.provider.name === "edge" &&
    requestedVoice &&
    !isValidEdgeVoice(requestedVoice)
  ) {
    deps.logger.warn(
      { event: "speech", outcome: "invalid_voice", provider: engine.provider.name },
      "rejected edge voice name not matching the neural pattern; falling back to engine default",
    );
  }
  const settings = {
    provider: engine.provider.name,
    model: engine.model,
    voice: voice ?? engine.defaultVoice,
    speed: parsed.data.speed ?? deps.config.SPEECH_DEFAULT_SPEED,
    // The engine decides its own container; a mismatched format request must
    // not silently produce audio the cache will mislabel.
    format: engine.format,
  };
  const key = await computeAudioCacheKey(text, settings);

  const cached = deps.cache.get(key);
  if (cached) {
    deps.logger.info(
      {
        event: "speech",
        outcome: "cache_hit",
        key: key.slice(0, 12),
        ms: Date.now() - started,
      },
      "speech served from cache",
    );
    return audio(cached.audio, cached.mimeType, key, "HIT", started);
  }

  if (signal?.aborted) {
    deps.logger.info(
      {
        event: "speech",
        outcome: "cancelled",
        provider: settings.provider,
        ms: Date.now() - started,
      },
      "speech request cancelled before synthesis",
    );
    return json(499, { error: "cancelled" }, { "cache-status": "none" });
  }

  try {
    const result = await engine.provider.synthesize({ text, settings, signal });
    // The audio is content-addressed and valid even if the caller aborted:
    // cache it anyway so a subsequent request hits.
    deps.cache.set(key, result);
    if (signal?.aborted) {
      deps.logger.info(
        {
          event: "speech",
          outcome: "cancelled",
          provider: settings.provider,
          ms: Date.now() - started,
        },
        "speech cancelled after synthesis (result cached)",
      );
      return json(499, { error: "cancelled" }, { "cache-status": "none" });
    }
    deps.logger.info(
      {
        event: "speech",
        outcome: "generated",
        provider: settings.provider,
        model: settings.model,
        content: contentFingerprint(text, (s) =>
          createHash("sha256").update(s).digest("hex"),
        ),
        bytes: result.audio.byteLength,
        ms: Date.now() - started,
      },
      "speech generated",
    );
    return audio(result.audio, result.mimeType, key, "MISS", started);
  } catch (error) {
    // Client cancellation (seek / document switch / aborted prefetch) is
    // normal traffic, not a provider incident: log it as cancelled.
    if (signal?.aborted) {
      deps.logger.info(
        {
          event: "speech",
          outcome: "cancelled",
          provider: settings.provider,
          ms: Date.now() - started,
        },
        "speech request cancelled by client",
      );
      return json(499, { error: "cancelled" }, { "cache-status": "none" });
    }
    const code = error instanceof SpeechError ? error.code : "provider_unavailable";
    const status =
      code === "invalid_request"
        ? 400
        : code === "rate_limited"
          ? 429
          : code === "provider_timeout"
            ? 504
            : 502;
    // Only stable codes reach the browser; error details stay in logs.
    deps.logger.error(
      {
        event: "speech",
        outcome: "error",
        code,
        provider: settings.provider,
        ms: Date.now() - started,
        message: error instanceof Error ? error.message : "unknown",
      },
      "speech generation failed",
    );
    return json(status, { error: code }, { "cache-status": "none" });
  }
}

function audio(
  bytes: Uint8Array,
  mimeType: string,
  key: string,
  cacheStatus: "HIT" | "MISS",
  started: number,
): HandlerResponse {
  return {
    status: 200,
    headers: {
      "content-type": mimeType,
      "cache-key": key,
      "cache-status": cacheStatus,
      "request-duration-ms": String(Date.now() - started),
      "cache-control": "private, max-age=86400",
    },
    audio: bytes,
  };
}

function json(
  status: number,
  body: unknown,
  headers: Record<string, string>,
): HandlerResponse {
  return { status, headers: { "content-type": "application/json", ...headers }, body };
}

export function clientKeyFromHeaders(headers: Headers): string {
  const forwarded = headers.get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || "local";
  return ip;
}
