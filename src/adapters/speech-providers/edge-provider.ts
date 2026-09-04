/**
 * Edge TTS provider — second engine with strong Spanish quality.
 *
 * Uses Microsoft Edge's free neural voices (es-ES-*, es-MX-*, en-US-* ...)
 * through the unofficial endpoint implemented by `msedge-tts`. No API key.
 * Treat it as an optional premium path: when it is not configured or the
 * endpoint misbehaves, the standard engine (NaN/Kokoro) covers everything.
 *
 * Security notes (this endpoint takes untrusted document text):
 * - `toStream()` interpolates text into an SSML template WITHOUT escaping,
 *   so we XML-escape all text here — document content can contain `<`, `>`,
 *   `&` and must never become markup;
 * - the voice name lands in an XML attribute, so it is validated against a
 *   strict `xx-YY-NameNeural` pattern before use (blocks attribute
 *   injection).
 */
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import {
  SpeechError,
  type SpeechProvider,
  type SpeechRequest,
  type SpeechResult,
} from "@/domain/speech/types";

export const EDGE_VOICE_PATTERN = /^[a-z]{2}-[A-Z]{2}-[A-Za-z0-9]+Neural$/;

export function isValidEdgeVoice(voice: string): boolean {
  return EDGE_VOICE_PATTERN.test(voice);
}

export function escapeSsmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export interface EdgeProviderOptions {
  /** Abort synthesis after this many ms. */
  timeoutMs: number;
  /** Keep at most this many live websocket clients (one per voice). */
  maxClients?: number;
}

export class EdgeSpeechProvider implements SpeechProvider {
  readonly name = "edge";
  /** One MsEdgeTTS instance per voice; the library reconnects on setMetadata,
   * so instances are created lazily and reused for sequential requests. */
  private clients = new Map<string, Promise<MsEdgeTTS>>();

  constructor(private readonly options: EdgeProviderOptions) {}

  private async clientFor(voice: string): Promise<MsEdgeTTS> {
    const existing = this.clients.get(voice);
    if (existing) return existing;
    const created = (async () => {
      const client = new MsEdgeTTS({ enableLogger: false });
      await client.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      return client;
    })();
    this.clients.set(voice, created);
    const max = this.options.maxClients ?? 6;
    if (this.clients.size > max) {
      const oldest = this.clients.keys().next().value as string;
      const evicted = this.clients.get(oldest);
      this.clients.delete(oldest);
      void evicted?.then((c) => c.close()).catch(() => undefined);
    }
    return created;
  }

  private evict(voice: string): void {
    const client = this.clients.get(voice);
    if (!client) return;
    this.clients.delete(voice);
    void client.then((c) => c.close()).catch(() => undefined);
  }

  async synthesize(request: SpeechRequest): Promise<SpeechResult> {
    const voice = request.settings.voice;
    if (!isValidEdgeVoice(voice)) {
      throw new SpeechError("invalid_request", `invalid edge voice: ${voice}`);
    }
    if (request.signal?.aborted) {
      throw new SpeechError("provider_timeout", "aborted before synthesis");
    }
    let client: MsEdgeTTS;
    try {
      client = await this.clientFor(voice);
    } catch (error) {
      this.evict(voice);
      throw new SpeechError("provider_unavailable", "edge tts connect failed", {
        retryable: true,
        cause: error,
      });
    }
    const started = Date.now();
    const { audioStream } = client.toStream(escapeSsmlText(request.text));
    const chunks: Buffer[] = [];
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          reject(
            new SpeechError("provider_timeout", "edge tts timed out", {
              retryable: true,
            }),
          );
        }, this.options.timeoutMs);
        const onAbort = () => {
          reject(new SpeechError("provider_timeout", "aborted by client"));
        };
        request.signal?.addEventListener("abort", onAbort, { once: true });
        audioStream.on("data", (c: Buffer) => chunks.push(Buffer.from(c)));
        audioStream.once("end", () => {
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          resolve();
        });
        audioStream.once("error", (err: Error) => {
          clearTimeout(timer);
          request.signal?.removeEventListener("abort", onAbort);
          reject(
            new SpeechError("provider_error", `edge tts stream error: ${err.message}`, {
              retryable: true,
              cause: err,
            }),
          );
        });
      });
    } catch (error) {
      // The websocket behind this voice may be wedged; force a fresh one next
      // time (a stale socket is the most common failure mode of this endpoint).
      audioStream.destroy();
      this.evict(voice);
      if (error instanceof SpeechError) throw error;
      throw new SpeechError("provider_unavailable", "edge tts failed", {
        retryable: true,
        cause: error,
      });
    }
    const audio = new Uint8Array(Buffer.concat(chunks));
    if (audio.byteLength === 0) {
      this.evict(voice);
      throw new SpeechError("provider_error", "edge tts returned empty audio", {
        retryable: true,
      });
    }
    return {
      audio,
      mimeType: "audio/mpeg",
      providerDurationMs: Date.now() - started,
    };
  }

  close(): void {
    for (const [voice] of this.clients) this.evict(voice);
  }
}
