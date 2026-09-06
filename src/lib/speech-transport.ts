/**
 * SpeechTransport — the single seam the reader/player uses to reach speech
 * synthesis.
 *
 * Two implementations share the same contract so the player and reader are
 * agnostic to whether speech is served by the Web backend (`/api/speech`) or by
 * the Tauri desktop bridge (which proxies to a bundled Node sidecar).
 *
 * Contract parity (must hold across both):
 *   - audio bytes + mime type
 *   - server cache status
 *   - provider-reported duration
 *   - word boundaries
 *   - provider name (for capability routing)
 *   - errors (stable codes only)
 *   - cancellation via the caller's AbortSignal
 */
import type { HealthDescriptor } from "./speech-player";
import type { WordBoundary } from "@/domain/speech/types";
import { WebSpeechTransport } from "./web-speech-transport";
import { DesktopSpeechTransport } from "./desktop-speech-transport";

export interface SpeechSynthesisRequest {
  text: string;
  voice?: string;
  engine?: string;
  speed?: number;
}

export interface SpeechSynthesisResult {
  /** Decoded audio bytes for the requested chunk. */
  audio: Blob;
  mimeType: string;
  /** Server-authoritative content cache key (used for IndexedDB caching). */
  cacheKey: string;
  cacheStatus: "HIT" | "MISS" | "none";
  /** Provider-reported synthesis duration, when available. */
  providerDurationMs?: number;
  /** Word/sentence boundaries, when the provider supplies them. */
  boundaries?: WordBoundary[];
  /** Provider name (e.g. "edge", "mock") for capability routing. */
  providerName?: string;
}

export interface SpeechTransport {
  readonly kind: "web" | "desktop";
  /** Engine/voice/runtime defaults used to compute cache keys. */
  health(): Promise<HealthDescriptor>;
  /** Synthesize one chunk. `signal` aborts the request (client cancellation). */
  synthesize(
    request: SpeechSynthesisRequest,
    signal?: AbortSignal,
  ): Promise<SpeechSynthesisResult>;
}

export function isDesktopRuntime(): boolean {
  return typeof window !== "undefined" && window.__TAURI_INTERNALS__ != null;
}

/** Build the transport for the current runtime (web or Tauri desktop). */
export function createSpeechTransport(
  fetchImpl: typeof fetch = fetch.bind(globalThis),
): SpeechTransport {
  if (isDesktopRuntime()) return new DesktopSpeechTransport();
  return new WebSpeechTransport(fetchImpl);
}
