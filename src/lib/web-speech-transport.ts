/**
 * WebSpeechTransport — the current browser behavior: POST to `/api/speech`,
 * GET `/api/health`. Preserves the exact response metadata contract so the
 * player reads the same cache status / boundaries / provider as before.
 */
import type {
  SpeechSynthesisRequest,
  SpeechSynthesisResult,
  SpeechTransport,
} from "./speech-transport";
import type { HealthDescriptor } from "./speech-player";
import type { WordBoundary } from "@/domain/speech/types";

export class WebSpeechTransport implements SpeechTransport {
  readonly kind = "web" as const;
  private readonly fetchImpl: typeof fetch;

  constructor(fetchImpl: typeof fetch = fetch.bind(globalThis)) {
    this.fetchImpl = fetchImpl;
  }

  async health(): Promise<HealthDescriptor> {
    const res = await this.fetchImpl("/api/health");
    if (!res.ok) throw new Error("health_unavailable");
    return (await res.json()) as HealthDescriptor;
  }

  async synthesize(
    request: SpeechSynthesisRequest,
    signal?: AbortSignal,
  ): Promise<SpeechSynthesisResult> {
    const response = await this.fetchImpl("/api/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      let code = "speech_error";
      try {
        const body = (await response.json()) as { error?: string };
        code = body.error ?? code;
      } catch {
        /* ignore malformed error body */
      }
      throw new Error(code);
    }

    const mimeType = response.headers.get("content-type") ?? "application/octet-stream";
    const cacheKey = response.headers.get("cache-key") ?? "";
    const rawStatus = response.headers.get("cache-status");
    const cacheStatus = rawStatus === "HIT" || rawStatus === "MISS" ? rawStatus : "none";

    const boundariesHeader = response.headers.get("x-word-boundaries");
    let boundaries: WordBoundary[] | undefined;
    if (boundariesHeader) {
      try {
        const parsed = JSON.parse(atob(boundariesHeader)) as WordBoundary[];
        if (Array.isArray(parsed) && parsed.length > 0) boundaries = parsed;
      } catch {
        /* tolerate malformed boundaries — audio is unaffected */
      }
    }

    const providerName = response.headers.get("x-provider") ?? undefined;
    const durationHeader = response.headers.get("request-duration-ms");
    const providerDurationMs =
      durationHeader !== null && Number.isFinite(Number(durationHeader))
        ? Number(durationHeader)
        : undefined;
    const audio = await response.blob();
    return {
      audio,
      mimeType,
      cacheKey,
      cacheStatus,
      providerDurationMs,
      boundaries,
      providerName,
    };
  }
}
