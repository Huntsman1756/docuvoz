/**
 * Mock speech provider.
 *
 * Produces a deterministic WAV of real, audible content proportional to text
 * length so the full stack — queue, cache, player, metrics — can be exercised
 * in CI and local development without any external service. It is also the
 * default provider for local development.
 *
 * The audio is a continuous, speech-like tone across its whole duration. It
 * must survive the engine's silence trim (trimSilence keeps samples above the
 * ~0.002 threshold): a mostly-silent buffer would be cut to ~0.1 s and the
 * player would blow through a whole document before a test could observe the
 * "Pausar" (playing) state — the flakiness this provider exists to avoid.
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

/** 16-bit mono 8kHz WAV; ~10 ms of audible content per text character, 1–3 s per chunk. */
export function buildWav(text: string): Uint8Array {
  const sampleRate = 8000;
  const hash = createHash("sha256").update(text).digest();
  const seconds = mockAudioSeconds(text);
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
  // A steady, syllabically-modulated tone (~200-320 Hz) at ~-11 dBFS. The
  // amplitude stays well above the trim threshold for the whole buffer so
  // trimSilence leaves the full duration intact and playback is observable.
  const freq = 180 + (tone % 140);
  for (let i = 0; i < samples; i++) {
    const t = i / sampleRate;
    const env = 0.7 + 0.3 * Math.sin(2 * Math.PI * 3 * t);
    const value = Math.sin(2 * Math.PI * freq * t) * 9000 * env;
    buffer.writeInt16LE(Math.round(value), 44 + i * 2);
  }
  return new Uint8Array(buffer);
}

/** Nominal audio duration (seconds) for the mock: 1–3 s, ~10 ms per char. */
function mockAudioSeconds(text: string): number {
  return Math.min(3, Math.max(1, text.length * 0.01));
}

/** Duration of the generated mock audio in ms (for tests/metrics). */
export function mockAudioDurationMs(text: string): number {
  return Math.round(mockAudioSeconds(text) * 1000);
}
