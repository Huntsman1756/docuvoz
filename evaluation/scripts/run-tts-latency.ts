/**
 * G1 — TTS latency measurement (LIVE, opt-in).
 *
 * Measures the *real* provider path so latency is measured, not assumed. This
 * is the only eval that touches the network and it refuses to run against the
 * mock provider by default (mock latency is meaningless).
 *
 *   RUN_LIVE_PROVIDER=1 SPEECH_PROVIDER=nan NAN_BASE_URL=... NAN_API_KEY=... \
 *     npm run eval:tts:live
 *
 * It synthesizes a spread of chunk sizes through the SAME paced provider the
 * server uses, records request duration, and estimates audio seconds from the
 * WAV/PCM byte length where decodable. Estimates for opaque containers (mp3)
 * are marked, never guessed. The point is the distribution and the
 * cache/pacing behavior, not a single number.
 */
import { createProvider, loadConfig } from "../../src/server/config";
import { computeAudioCacheKey } from "../../src/infrastructure/cache/cache-key";
import type { SpeechSettings } from "../../src/domain/speech/types";
import { percentile, writeResult } from "./shared";

const SAMPLES: { label: string; text: string }[] = [
  { label: "short", text: "Artículo cinco, apartado dos." },
  {
    label: "medium",
    text: "Las entidades deberán remitir la información antes del quince de julio de dos mil veinticuatro, a más tardar.",
  },
  {
    label: "long",
    text:
      "El umbral máximo será de un millón doscientos treinta y cuatro mil quinientos sesenta y siete euros con ochenta y nueve céntimos, " +
      "equivalente al ocho coma cinco por ciento del total del balance auditado, sin perjuicio de las excepciones previstas en la disposición adicional tercera.",
  },
];

function estimateAudioMs(settings: SpeechSettings, bytes: Uint8Array): number | null {
  // Decodable formats only. For 16-bit mono WAV we can read the header.
  const ascii = String.fromCharCode(...bytes.slice(0, 4));
  if (settings.format === "wav" && ascii === "RIFF" && bytes.length >= 44) {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const byteRate = view.getUint32(28, true);
    const dataSize = view.getUint32(40, true);
    if (byteRate > 0) return Math.round((dataSize / byteRate) * 1000);
    return null;
  }
  return null; // mp3/opus: do not estimate duration from bytes.
}

async function main(): Promise<void> {
  if (process.env.RUN_LIVE_PROVIDER !== "1") {
    console.error(
      "[eval:tts:live] refusing to run: set RUN_LIVE_PROVIDER=1 with SPEECH_PROVIDER=nan and valid credentials.\n" +
        "             Latency against the mock provider is not a real measurement.",
    );
    process.exit(2);
  }
  const config = loadConfig();
  if (config.SPEECH_PROVIDER !== "nan") {
    console.error(
      "[eval:tts:live] set SPEECH_PROVIDER=nan to measure the real provider.",
    );
    process.exit(2);
  }
  const provider = createProvider(config);
  const settings: SpeechSettings = {
    provider: "nan",
    model: config.NAN_TTS_MODEL,
    voice: config.NAN_TTS_VOICE,
    speed: config.SPEECH_DEFAULT_SPEED,
    format: config.NAN_TTS_FORMAT,
  };

  const samples: unknown[] = [];
  const durationsMs: number[] = [];
  for (const sample of SAMPLES) {
    const key = await computeAudioCacheKey(sample.text, settings);
    const started = Date.now();
    try {
      const result = await provider.synthesize({ text: sample.text, settings });
      const ms = Date.now() - started;
      durationsMs.push(ms);
      samples.push({
        label: sample.label,
        chars: sample.text.length,
        ok: true,
        ms,
        bytes: result.audio.byteLength,
        mimeType: result.mimeType,
        audioMsEstimate: estimateAudioMs(settings, result.audio),
        cacheKeyPrefix: key.slice(0, 12),
      });
      console.log(`  ${sample.label}: ${ms} ms, ${result.audio.byteLength} bytes`);
    } catch (error) {
      const ms = Date.now() - started;
      samples.push({
        label: sample.label,
        chars: sample.text.length,
        ok: false,
        ms,
        error: error instanceof Error ? error.name : "unknown",
      });
      console.error(`  ${sample.label}: FAILED after ${ms} ms`);
    }
  }

  const result = {
    generatedAt: new Date().toISOString(),
    gate: "G1",
    provider: "nan",
    model: config.NAN_TTS_MODEL,
    voice: config.NAN_TTS_VOICE,
    format: config.NAN_TTS_FORMAT,
    pacing: {
      maxConcurrency: config.SPEECH_MAX_CONCURRENCY,
      requestsPerMinute: config.SPEECH_REQUESTS_PER_MINUTE,
      minIntervalMs: Math.ceil(60_000 / config.SPEECH_REQUESTS_PER_MINUTE),
    },
    caveat:
      "Serial single-shot latencies (each preceded by cache-miss). Real interactive time-to-playable depends on prefetch depth and is measured in-browser; see docs/evaluation.md. Provider-side per-minute plan limits must be validated with a sustained test before any beta.",
    samples,
    summary: {
      successes: durationsMs.length,
      failures: SAMPLES.length - durationsMs.length,
      latencyP50Ms: percentile(durationsMs, 0.5),
      latencyP95Ms: percentile(durationsMs, 0.95),
    },
  };
  const path = writeResult("tts.json", result);
  console.log(`[eval:tts:live] wrote ${path}`);
  if (result.summary.failures > 0) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
