/**
 * Server-side configuration. Validated eagerly at startup (see
 * src/instrumentation.ts). Fail-fast with a clear message; never print secrets.
 */
import { z } from "zod";
import { MockSpeechProvider } from "@/adapters/speech-providers/mock-provider";
import { NanSpeechProvider } from "@/adapters/speech-providers/nan-provider";
import { PacedProvider } from "@/adapters/speech-providers/pacing";
import type { SpeechProvider } from "@/domain/speech/types";

// A blank line in `.env` (`KEY=`) yields an empty string, not undefined. Without
// this coercion the verbatim `.env.example -> .env.local` copy fails validation
// even in mock mode (onboarding bug found dogfooding). Treat blank as "unset".
const blankToUndefined = (v: unknown) => (v === "" || v === undefined ? undefined : v);

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

export function createProvider(config: ServerConfig): SpeechProvider {
  const inner: SpeechProvider =
    config.SPEECH_PROVIDER === "nan"
      ? new NanSpeechProvider({
          baseUrl: config.NAN_BASE_URL as string,
          apiKey: config.NAN_API_KEY as string,
          timeoutMs: config.SPEECH_TIMEOUT_MS,
        })
      : new MockSpeechProvider({ latencyMs: 150 });

  return new PacedProvider(inner, {
    maxConcurrency: config.SPEECH_MAX_CONCURRENCY,
    // Account for provider-specific pacing (e.g. Kokoro plans): derive the
    // minimum inter-request interval from requests-per-minute.
    minIntervalMs: Math.ceil(60_000 / config.SPEECH_REQUESTS_PER_MINUTE),
    maxAttempts: config.SPEECH_MAX_ATTEMPTS,
  });
}

/** Singleton wired at startup; routes import this, never env directly. */
let cached: { config: ServerConfig; provider: SpeechProvider } | null = null;

export function getServerRuntime(): {
  config: ServerConfig;
  provider: SpeechProvider;
} {
  if (!cached) {
    const config = loadConfig();
    cached = { config, provider: createProvider(config) };
  }
  return cached;
}
