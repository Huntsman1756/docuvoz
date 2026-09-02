/**
 * Speech domain contract. The domain depends only on these types; provider
 * specifics live in src/adapters/speech-providers.
 */

export interface SpeechSettings {
  provider: string;
  model: string;
  voice: string;
  /** Playback speed multiplier at synthesis time. */
  speed: number;
  /** Container/encoding, e.g. "mp3", "wav", "opus". */
  format: string;
}

export interface SpeechRequest {
  /** Normalized spoken text (already fidelity-validated). */
  text: string;
  settings: SpeechSettings;
  /** Optional cancellation. */
  signal?: AbortSignal;
}

export interface SpeechResult {
  audio: Uint8Array;
  mimeType: string;
  /** Provider-reported synthesis duration when available. */
  providerDurationMs?: number;
}

export interface SpeechProvider {
  readonly name: string;
  synthesize(request: SpeechRequest): Promise<SpeechResult>;
}

export type SpeechErrorCode =
  | "provider_unavailable"
  | "provider_error"
  | "provider_timeout"
  | "rate_limited"
  | "invalid_request"
  | "too_large";

export class SpeechError extends Error {
  readonly code: SpeechErrorCode;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    code: SpeechErrorCode,
    message: string,
    options: { retryable?: boolean; status?: number; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause });
    this.name = "SpeechError";
    this.code = code;
    this.retryable = options.retryable ?? false;
    this.status = options.status;
  }
}
