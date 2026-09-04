/**
 * Server-side configuration. Validated eagerly at startup (see
 * src/instrumentation.ts). Fail-fast with a clear message; never print secrets.
 *
 * The runtime exposes an ENGINE REGISTRY (Personal Reader v0.3): engine id 0
 * is the default (NaN/Kokoro or mock), and optional free engines (Edge TTS
 * neural voices) can be enabled per deployment. The browser picks an engine
 * by opaque id — internal provider names stay in /lab and the logs.
 */
import { z } from "zod";
import { MockSpeechProvider } from "@/adapters/speech-providers/mock-provider";
import { NanSpeechProvider } from "@/adapters/speech-providers/nan-provider";
import { EdgeSpeechProvider } from "@/adapters/speech-providers/edge-provider";
import { PacedProvider } from "@/adapters/speech-providers/pacing";
import type { SpeechProvider } from "@/domain/speech/types";

// A blank line in `.env` (`KEY=`) yields an empty string, not undefined. Without
// this coercion the verbatim `.env.example -> .env.local` copy fails validation
// even in mock mode (onboarding bug found dogfooding). Treat blank as "unset".
const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);
// Explicit truthy set: `z.coerce.boolean()` would turn "false"/"0" into true.
const toFlag = (v: unknown) => v === true || v === "1" || v === "true";

const EnvSchema = z.object({
  SPEECH_PROVIDER: z.enum(["mock", "nan"]).default("mock"),
  NAN_BASE_URL: z.preprocess(blankToUndefined, z.string().url().optional()),
  NAN_API_KEY: z.preprocess(
    blankToUndefined,
    z.string().min(8, "NAN_API_KEY looks too short").optional(),
  ),
  NAN_TTS_MODEL: z.string().default("kokoro"),
  NAN_TTS_VOICE: z.string().default("ef_dora"),
  NAN_TTS_FORMAT: z.string().default("mp3"),
  // Optional second engine: free Microsoft Edge neural voices, strong Spanish.
  EDGE_TTS_ENABLED: z.preprocess((v) => toFlag(v), z.boolean().default(false)),
  EDGE_TTS_VOICE: z.string().default("es-ES-XimenaNeural"),
  SPEECH_TIMEOUT_MS: z.coerce.number().int().min(1000).max(120000).default(30000),
  SPEECH_MAX_CONCURRENCY: z.coerce.number().int().min(1).max(4).default(1),
  SPEECH_REQUESTS_PER_MINUTE: z.coerce.number().int().min(1).max(120).default(20),
  SPEECH_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(6).default(3),
  SPEECH_CACHE_DIR: z.string().default(".cache/audio"),
  SPEECH_MAX_TEXT_CHARS: z.coerce.number().int().min(50).max(4000).default(600),
  SPEECH_DEFAULT_SPEED: z.coerce.number().min(0.5).max(2).default(1),
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().int().min(1).max(1000).default(60),
  API_MAX_BODY_BYTES: z.coerce.number().int().min(1024).default(16384),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  NODE_ENV: z.string().default("development"),
});

export type ServerConfig = z.infer<typeof EnvSchema>;

export class ConfigError extends Error {}

export function loadConfig(
  env: Record<string, string | undefined> = process.env,
): ServerConfig {
  const parsed = EnvSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`invalid environment configuration: ${issues}`);
  }
  const config = parsed.data;
  if (config.SPEECH_PROVIDER === "nan") {
    if (!config.NAN_BASE_URL || !config.NAN_API_KEY) {
      throw new ConfigError(
        "SPEECH_PROVIDER=nan requires NAN_BASE_URL and NAN_API_KEY (see .env.example)",
      );
    }
  }
  return config;
}

/** One selectable synthesis engine: what the browser may address by id. */
export interface EngineRuntime {
  id: string;
  /** Product-facing label (never a provider brand). */
  label: string;
  provider: SpeechProvider;
  model: string;
  defaultVoice: string;
  /** Container this engine serves; the browser must not override it. */
  format: string;
}

function pace(config: ServerConfig, inner: SpeechProvider): SpeechProvider {
  return new PacedProvider(inner, {
    maxConcurrency: config.SPEECH_MAX_CONCURRENCY,
    // Account for provider-specific pacing (e.g. Kokoro plans): derive the
    // minimum inter-request interval from requests-per-minute.
    minIntervalMs: Math.ceil(60_000 / config.SPEECH_REQUESTS_PER_MINUTE),
    maxAttempts: config.SPEECH_MAX_ATTEMPTS,
  });
}

export function createEngines(config: ServerConfig): EngineRuntime[] {
  const engines: EngineRuntime[] = [];
  if (config.SPEECH_PROVIDER === "nan") {
    engines.push({
      id: "default",
      label: "Estándar",
      provider: pace(
        config,
        new NanSpeechProvider({
          baseUrl: config.NAN_BASE_URL as string,
          apiKey: config.NAN_API_KEY as string,
          timeoutMs: config.SPEECH_TIMEOUT_MS,
        }),
      ),
      model: config.NAN_TTS_MODEL,
      defaultVoice: config.NAN_TTS_VOICE,
      format: config.NAN_TTS_FORMAT,
    });
  } else {
    engines.push({
      id: "default",
      label: "Estándar",
      provider: pace(config, new MockSpeechProvider({ latencyMs: 150 })),
      model: "mock-v1",
      defaultVoice: "mock",
      format: "wav",
    });
  }
  if (config.EDGE_TTS_ENABLED) {
    engines.push({
      id: "edge",
      label: "Edge TTS",
      provider: pace(
        config,
        new EdgeSpeechProvider({ timeoutMs: config.SPEECH_TIMEOUT_MS }),
      ),
      model: "edge-neural-1",
      defaultVoice: config.EDGE_TTS_VOICE,
      format: "mp3",
    });
  }
  return engines;
}

export function createProvider(config: ServerConfig): SpeechProvider {
  return createEngines(config)[0].provider;
}

/** Singleton wired at startup; routes import this, never env directly. */
let cached: {
  config: ServerConfig;
  engines: EngineRuntime[];
  provider: SpeechProvider;
} | null = null;

export function getServerRuntime(): {
  config: ServerConfig;
  engines: EngineRuntime[];
  provider: SpeechProvider;
} {
  if (!cached) {
    const config = loadConfig();
    const engines = createEngines(config);
    cached = { config, engines, provider: engines[0].provider };
  }
  return cached;
}
