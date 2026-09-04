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

/** Word/sentence boundary from a TTS provider. */
export interface WordBoundary {
  /** The spoken text for this boundary unit. */
  text: string;
  /** Offset from the start of the audio, in seconds. */
  offsetSeconds: number;
  /** Duration of this boundary unit, in seconds. */
  durationSeconds: number;
}

export interface SpeechResult {
  audio: Uint8Array;
  mimeType: string;
  /** Provider-reported synthesis duration when available. */
  providerDurationMs?: number;
  /** Word/sentence boundaries when the provider supplies them. */
  boundaries?: WordBoundary[];
}

export interface ProviderCapabilities {
  /** Whether this provider returns word-level timestamp/boundary data. */
  supportsWordBoundaries: boolean;
  /** Whether this provider streams audio incrementally. */
  supportsStreaming: boolean;
  /** Whether this provider reports exact audio duration. */
  supportsExactDuration: boolean;
}

export interface ProviderMetadata {
  /** Provider name / id. */
  name: string;
  /** Capabilities of this provider. */
  capabilities: ProviderCapabilities;
}

export interface SpeechProvider {
  readonly name: string;
  /** Return metadata about this provider's capabilities. */
  getMetadata?(): ProviderMetadata;
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
