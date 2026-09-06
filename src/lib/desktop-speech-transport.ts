/**
 * DesktopSpeechTransport — reaches speech synthesis through the Tauri bridge.
 *
 * The WebView never learns the sidecar port, its authentication token, or any
 * provider API key. It only:
 *   - invokes `speech_health` → engine/runtime defaults
 *   - invokes `speech` with a requestId → raw binary frame (metadata + audio)
 *   - invokes `speech_cancel` with a requestId → Rust cancels the sidecar
 *
 * Cancellation mirrors the Web AbortSignal contract: each request is tracked
 * by requestId, and an aborted caller signal cancels the sidecar request so a
 * document switch never leaks a provider slot or yields stale audio.
 */
import type {
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  SpeechTransport,
} from "./speech-transport";
import type { HealthDescriptor } from "./speech-player";
import type { WordBoundary } from "@/domain/speech/types";

const MAX_METADATA_BYTES = 64 * 1024;

interface FrameMetadata {
  mimeType: string;
  cacheKey: string;
  cacheStatus: "HIT" | "MISS" | "none";
  providerDurationMs?: number;
  boundaries?: WordBoundary[];
  providerName?: string;
  error?: string;
}

export class DesktopSpeechTransport implements SpeechTransport {
  readonly kind = "desktop" as const;
  private readonly pending = new Map<string, AbortController>();

  private invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
    const tauri = window.__TAURI__;
    if (!tauri) {
      return Promise.reject(new Error("desktop_bridge_unavailable"));
    }
    return tauri.core.invoke<T>(cmd, args);
  }

  async health(): Promise<HealthDescriptor> {
    return this.invoke<HealthDescriptor>("speech_health");
  }

  async synthesize(
    request: SpeechSynthesisRequest,
    signal?: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    const requestId = crypto.randomUUID();
    const controller = new AbortController();
    this.pending.set(requestId, controller);

    // Race the invoke against caller cancellation so an abort rejects promptly
    // with an AbortError (mirroring the Web transport) while also telling Rust
    // to cancel the sidecar request (no provider slot leak, no stale audio).
    const abortPromise = new Promise<never>((_, reject) => {
      const onAbort = () => {
        controller.abort();
        void this.invoke("speech_cancel", { requestId }).catch(() => undefined);
        reject(new DOMException("The operation was aborted.", "AbortError"));
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort);
    });

    try {
      const frame = await Promise.race([
        this.invoke<ArrayBuffer>("speech", {
          requestId,
          text: request.text,
          voice: request.voice,
          engine: request.engine,
          speed: request.speed,
        }),
        abortPromise,
      ]);
      return parseFrame(frame);
    } finally {
      this.pending.delete(requestId);
    }
  }
}

/**
 * Parse the compact binary envelope:
 *   uint32 metadataLength (little-endian) | UTF-8 metadata JSON | raw audio
 */
export function parseFrame(frame: ArrayBuffer): SpeechSynthesisResult {
  const bytes = new Uint8Array(frame);
  if (bytes.length < 4) throw new Error("malformed_frame");
  const view = new DataView(frame);
  const metadataLength = view.getUint32(0, true);
  if (metadataLength < 2 || metadataLength > MAX_METADATA_BYTES) {
    throw new Error("malformed_frame_metadata");
  }
  if (bytes.length < 4 + metadataLength) throw new Error("truncated_frame");

  let metadata: FrameMetadata;
  try {
    const metadataText = new TextDecoder("utf-8", { fatal: true }).decode(
      bytes.subarray(4, 4 + metadataLength),
    );
    metadata = JSON.parse(metadataText) as FrameMetadata;
  } catch {
    throw new Error("malformed_frame_metadata");
  }

  if (metadata.error) throw new Error(metadata.error);

  const audioBytes = bytes.subarray(4 + metadataLength);
  return {
    audio: new Blob([audioBytes], { type: metadata.mimeType }),
    mimeType: metadata.mimeType,
    cacheKey: metadata.cacheKey ?? "",
    cacheStatus: metadata.cacheStatus ?? "none",
    providerDurationMs: metadata.providerDurationMs,
    boundaries: metadata.boundaries,
    providerName: metadata.providerName,
  };
}
