/**
 * NaN provider — DEVELOPMENT / VALIDATION INFRASTRUCTURE, not product
 * infrastructure.
 *
 * Talks to an OpenAI-compatible `/audio/speech` style endpoint behind a base
 * URL, using the configured (e.g. Kokoro) model. API credentials stay on the
 * server; the browser only ever calls our own route. See docs/providers.md
 * for licensing / rate-limit caveats before any public exposure.
 */
import {
  SpeechError,
  type SpeechProvider,
  type SpeechRequest,
  type SpeechResult,
} from "@/domain/speech/types";

export interface NanProviderOptions {
  baseUrl: string;
  apiKey: string;
  /** Abort the fetch after this many ms of total request time. */
  timeoutMs: number;
  fetchFn?: typeof fetch;
}

export class NanSpeechProvider implements SpeechProvider {
  readonly name = "nan";

  constructor(private readonly options: NanProviderOptions) {}

  async synthesize(request: SpeechRequest): Promise<SpeechResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    const onAbort = () => controller.abort();
    request.signal?.addEventListener("abort", onAbort);
    const started = Date.now();
    try {
      const response = await (this.options.fetchFn ?? fetch)(
        `${this.options.baseUrl.replace(/\/+$/, "")}/audio/speech`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.options.apiKey}`,
          },
          body: JSON.stringify({
            model: request.settings.model,
            input: request.text,
            voice: request.settings.voice,
            speed: request.settings.speed,
            response_format: request.settings.format,
          }),
          signal: controller.signal,
        },
      );
      if (!response.ok) {
        const retryable = response.status === 429 || response.status >= 500;
        throw new SpeechError(
          response.status === 429 ? "rate_limited" : "provider_error",
          `NaN provider returned HTTP ${response.status}`,
          { retryable, status: response.status },
        );
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength === 0) {
        throw new SpeechError("provider_error", "NaN provider returned empty audio", {
          retryable: true,
        });
      }
      return {
        audio: bytes,
        mimeType: mimeForFormat(request.settings.format),
        providerDurationMs: Date.now() - started,
      };
    } catch (error) {
      if (error instanceof SpeechError) throw error;
      if (controller.signal.aborted && !request.signal?.aborted) {
        throw new SpeechError("provider_timeout", "NaN provider timed out", {
          retryable: true,
        });
      }
      if (request.signal?.aborted) {
        throw new SpeechError("provider_timeout", "aborted by client");
      }
      throw new SpeechError("provider_unavailable", "NaN provider unreachable", {
        retryable: true,
        cause: error,
      });
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
    }
  }
}

function mimeForFormat(format: string): string {
  switch (format) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "opus":
      return "audio/opus";
    case "flac":
      return "audio/flac";
    case "pcm":
      return "audio/L16;rate=24000";
    default:
      return "application/octet-stream";
  }
}
