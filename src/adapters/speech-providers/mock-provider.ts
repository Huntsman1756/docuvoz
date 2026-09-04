/**
 * Mock speech provider.
 *
 * Produces a deterministic tiny WAV (silence with a leading tone proportional
 * to text length) so the full stack — queue, cache, player, metrics — can be
 * exercised in CI and local development without any external service. It is
 * also the default provider for local development.
 */
import { createHash } from "node:crypto";
import {
  SpeechError,
  type SpeechProvider,
  type SpeechRequest,
  type SpeechResult,
} from "@/domain/speech/types";

export class MockSpeechProvider implements SpeechProvider {
  readonly name = "mock";

  getMetadata() {
    return {
      name: "mock",
      capabilities: {
        supportsWordBoundaries: false,
        supportsStreaming: false,
        supportsExactDuration: true,
      },
    };
  }

  private counter = 0;

  constructor(
    private readonly options: {
      /** Simulated per-request latency in ms. */
      latencyMs?: number;
      /** Fail the Nth request to test retry paths. */
      failEvery?: number;
    } = {},
  ) {}

  async synthesize(request: SpeechRequest): Promise<SpeechResult> {
    const latency = this.options.latencyMs ?? 0;
    if (latency > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, latency);
        request.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          reject(new SpeechError("provider_timeout", "aborted"));
        });
      });
    }
    this.counter += 1;
    if (this.options.failEvery && this.counter % this.options.failEvery === 0) {
      throw new SpeechError("provider_error", "mock injected failure", {
        retryable: true,
        status: 503,
      });
    }
    if (request.text.trim().length === 0) {
      throw new SpeechError("invalid_request", "empty text");
    }
    return { audio: buildWav(request.text), mimeType: "audio/wav" };
  }
}

/** 16-bit mono 8kHz WAV; duration ~60ms per text character (cap 20s). */
export function buildWav(text: string): Uint8Array {
  const sampleRate = 8000;
  const hash = createHash("sha256").update(text).digest();
  const seconds = Math.min(20, Math.max(0.25, text.length * 0.06 + (hash[0] % 40) / 100));
  const samples = Math.floor(sampleRate * seconds);
  const dataSize = samples * 2;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);
  const tone = hash[1];
  for (let i = 0; i < samples; i++) {
    const value = i < sampleRate * 0.05 ? Math.sin(i / 6) * 2000 * (tone / 255) : 0;
    buffer.writeInt16LE(Math.round(value), 44 + i * 2);
  }
  return new Uint8Array(buffer);
}

/** Duration of the generated mock audio in ms (for tests/metrics). */
export function mockAudioDurationMs(text: string): number {
  const hash = createHash("sha256").update(text).digest();
  return Math.min(20000, Math.max(250, text.length * 60 + (hash[0] % 40) * 10));
}
