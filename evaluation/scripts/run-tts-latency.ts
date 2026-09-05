/**
 * G1 — live provider measurement (transport/latency ONLY).
 *
 * This script closes at most `G1_PROVIDER_CONNECTIVITY` and
 * `G1_PROVIDER_LATENCY` plus a rate-behavior measurement. It is evidence that
 * the transport works and how it performs — never a statement that the
 * provider is suitable as product infrastructure (that is a documented human
 * decision, see docs/providers.md).
 *
 *   RUN_LIVE_PROVIDER=1 SPEECH_PROVIDER=nan NAN_BASE_URL=... NAN_API_KEY=... \
 *     npm run eval:tts:live -- --samples 25 --burn 30
 *
 * What is measured per request, through the SAME pacing/retry stack the
 * server uses (manually composed here for instrumentation):
 *   - TTFA: fetch start -> first response-body byte
 *   - wire latency per attempt, backoff gaps between attempts
 *   - pacing queue wait (enqueue -> first attempt dispatch)
 *   - retries, HTTP statuses (incl. 429s)
 *   - audio duration (exact for WAV; null, never guessed, for mp3) and RTF
 *   - bytes
 *
 * The sample set is a stratified selection of REAL Listen-mode chunks from
 * the corpus (short/mid/long), not three toy strings. `--burn N` fires N
 * further requests through the real pacing layer to observe 429 behavior at
 * the configured SPEECH_REQUESTS_PER_MINUTE plan.
 *
 * Mock runs are a pipeline self-test only and go to a SEPARATE file
 * (`tts.wiring-smoke.json`) so they can never masquerade as G1 evidence:
 *   npm run eval:tts:wiring
 */
import { MockSpeechProvider } from "../../src/adapters/speech-providers/mock-provider";
import { NanSpeechProvider } from "../../src/adapters/speech-providers/nan-provider";
import { PacedProvider } from "../../src/adapters/speech-providers/pacing";
import { buildSpokenPlan } from "../../src/domain/spoken/pipeline";
import { planChunks } from "../../src/domain/spoken/speech-plan";
import type {
  SpeechProvider,
  SpeechRequest,
  SpeechResult,
} from "../../src/domain/speech/types";
import { loadConfig, type ServerConfig } from "../../src/server/config";
import {
  loadManifest,
  loadReference,
  percentile,
  readWavDurationMs,
  writeResult,
} from "./shared";

interface WireEvent {
  status: number;
  ttfaMs: number | null;
  totalMs: number;
  bytes: number;
  retryAfter: string | null;
}

interface AttemptRecord {
  startedAt: number;
  endedAt: number;
  ok: boolean;
  errorName: string | null;
  errorCode: string | null;
  status: number | null;
  wireEvents: WireEvent[];
}

/** Instrumented fetch: records status, TTFA (first body byte) and bytes. */
function makeInstrumentedFetch(sink: () => void): {
  fetchFn: typeof fetch;
  drain: () => WireEvent[];
} {
  const events: WireEvent[] = [];
  const fetchFn: typeof fetch = async (input, init) => {
    const t0 = performance.now();
    const res = await fetch(input, init);
    let ttfaMs: number | null = null;
    let bytes = res.headers.get("content-length");
    let body: Uint8Array | null = null;
    if (res.body) {
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          if (ttfaMs === null) ttfaMs = Math.round(performance.now() - t0);
          chunks.push(value);
          total += value.byteLength;
        }
      }
      bytes = String(total);
      body = new Uint8Array(total);
      let off = 0;
      for (const c of chunks) {
        body.set(c, off);
        off += c.byteLength;
      }
    }
    const event: WireEvent = {
      status: res.status,
      ttfaMs,
      totalMs: Math.round(performance.now() - t0),
      bytes: body ? body.byteLength : Number(bytes ?? 0) || 0,
      retryAfter: res.headers.get("retry-after"),
    };
    events.push(event);
    sink();
    const rebuilt = new Response(
      body
        ? (body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer)
        : null,
      {
        status: res.status,
        statusText: res.statusText,
        headers: res.headers,
      },
    );
    return rebuilt;
  };
  return {
    fetchFn,
    drain: () => events.splice(0, events.length),
  };
}

/** Records every dispatch into the inner (unpaced) provider. */
class ObservingProvider implements SpeechProvider {
  readonly name: string;
  readonly attempts: AttemptRecord[] = [];
  constructor(
    private readonly inner: SpeechProvider,
    private readonly drainWire: () => WireEvent[],
  ) {
    this.name = inner.name;
  }
  async synthesize(request: SpeechRequest): Promise<SpeechResult> {
    const record: AttemptRecord = {
      startedAt: Date.now(),
      endedAt: 0,
      ok: false,
      errorName: null,
      errorCode: null,
      status: null,
      wireEvents: [],
    };
    try {
      const result = await this.inner.synthesize(request);
      record.ok = true;
      return result;
    } catch (error) {
      record.errorName = error instanceof Error ? error.name : "unknown";
      const code = (error as { code?: string }).code;
      record.errorCode = typeof code === "string" ? code : null;
      throw error;
    } finally {
      record.endedAt = Date.now();
      record.wireEvents = this.drainWire();
      const last = record.wireEvents.at(-1);
      if (last) record.status = last.status;
      this.attempts.push(record);
    }
  }
}

interface SampleText {
  label: string;
  text: string;
}

/** Stratified REAL chunks (short/mid/long) from corpus Listen plans. */
function collectSamples(wanted: number): SampleText[] {
  const seen = new Set<string>();
  const buckets: Record<"short" | "mid" | "long", SampleText[]> = {
    short: [],
    mid: [],
    long: [],
  };
  for (const entry of loadManifest().entries) {
    if (!entry.reference) continue; // reader-sample fixtures (EPUB/DOCX) have no eval reference
    const plan = buildSpokenPlan(loadReference(entry), "listen");
    for (const chunk of planChunks(plan)) {
      const text = chunk.text.trim();
      if (!text || seen.has(text)) continue;
      const cls = text.length < 120 ? "short" : text.length <= 260 ? "mid" : "long";
      seen.add(text);
      buckets[cls].push({ label: `${entry.id}:${cls}:${chunk.id}`, text });
    }
  }
  const picked: SampleText[] = [];
  const quota = {
    short: Math.ceil(wanted * 0.3),
    mid: Math.ceil(wanted * 0.4),
    long: Math.max(0, wanted - Math.ceil(wanted * 0.3) - Math.ceil(wanted * 0.4)),
  };
  for (const cls of ["short", "mid", "long"] as const) {
    const list = buckets[cls];
    if (list.length <= quota[cls]) {
      picked.push(...list);
      continue;
    }
    const step = list.length / quota[cls];
    for (let i = 0; i < quota[cls]; i++) {
      picked.push(list[Math.floor(i * step)]);
    }
  }
  return picked.slice(0, wanted);
}

interface RequestRecord {
  label: string;
  chars: number;
  ok: boolean;
  totalMs: number;
  queueWaitMs: number | null;
  attempts: number;
  retries: number;
  backoffGapsMs: number[];
  successfulAttemptWireMs: number | null;
  firstAttemptTtfaMs: number | null;
  successfulTtfaMs: number | null;
  statusCodes: (number | null)[];
  retryAfterSeen: string[];
  bytes: number | null;
  audioMs: number | null;
  rtf: number | null;
  error: string | null;
}

async function measureRequest(
  paced: PacedProvider,
  obs: ObservingProvider,
  sample: SampleText,
  settings: SpeechRequest["settings"],
): Promise<RequestRecord> {
  const attemptBase = obs.attempts.length;
  const enqueueAt = Date.now();
  let result: SpeechResult | null = null;
  let error: string | null = null;
  try {
    result = await paced.synthesize({ text: sample.text, settings });
  } catch (err) {
    error =
      err instanceof Error
        ? `${err.name}:${(err as { code?: string }).code ?? "?"}`
        : "unknown";
  }
  const endedAt = Date.now();
  const attempts = obs.attempts.slice(attemptBase);
  const ok = result !== null;
  const first = attempts[0];
  const lastOk = [...attempts].reverse().find((a) => a.ok);
  const backoffGapsMs: number[] = [];
  for (let i = 1; i < attempts.length; i++) {
    backoffGapsMs.push(attempts[i].startedAt - attempts[i - 1].endedAt);
  }
  const audioMs = result && ok ? readWavDurationMs(result.audio) : null;
  const wireMs = lastOk ? lastOk.endedAt - lastOk.startedAt : null;
  const firstAttemptWire = first?.wireEvents.find((e) => e.ttfaMs !== null);
  const okWire = lastOk?.wireEvents.find((e) => e.ttfaMs !== null);
  return {
    label: sample.label,
    chars: sample.text.length,
    ok,
    totalMs: endedAt - enqueueAt,
    queueWaitMs: first ? first.startedAt - enqueueAt : null,
    attempts: attempts.length,
    retries: attempts.length - 1,
    backoffGapsMs,
    successfulAttemptWireMs: wireMs,
    firstAttemptTtfaMs: firstAttemptWire?.ttfaMs ?? null,
    successfulTtfaMs: okWire?.ttfaMs ?? null,
    statusCodes: attempts.map((a) => a.status),
    retryAfterSeen: attempts
      .flatMap((a) => a.wireEvents.map((w) => w.retryAfter))
      .filter((s): s is string => s !== null),
    bytes: result ? result.audio.byteLength : null,
    audioMs,
    rtf: audioMs && wireMs ? Math.round((wireMs / audioMs) * 1000) / 1000 : null,
    error,
  };
}

interface BurnRecord {
  requests: number;
  successes: number;
  failures: number;
  wireRequests: number;
  count429: number;
  count5xx: number;
  retriesTotal: number;
  retryAfterSeen: string[];
  latencyMinMs: number | null;
  latencyMaxMs: number | null;
  wallClockMs: number;
  effectiveRequestsPerMinute: number;
  note: string;
}

async function runBurn(
  paced: PacedProvider,
  obs: ObservingProvider,
  settings: SpeechRequest["settings"],
  requests: number,
): Promise<BurnRecord> {
  // Sustained run through the REAL pacing layer. 429s are counted at the
  // wire (attempt log), so errors the retry layer absorbs are still visible
  // — that is the point: prove pacing makes them unnecessary, do not rely
  // on retries to hide them.
  const text =
    "El plazo de presentación finaliza el quince de julio de dos mil veinticuatro, a más tardar.";
  const base = obs.attempts.length;
  const t0 = Date.now();
  let successes = 0;
  let failures = 0;
  const latencyMs: number[] = [];
  for (let i = 0; i < requests; i++) {
    const r0 = Date.now();
    try {
      await paced.synthesize({ text, settings });
      successes += 1;
      latencyMs.push(Date.now() - r0);
    } catch {
      failures += 1;
    }
  }
  const wallClockMs = Date.now() - t0;
  const wire = obs.attempts.slice(base).flatMap((a) => a.wireEvents.map((w) => w));
  return {
    requests,
    successes,
    failures,
    wireRequests: wire.length,
    count429: wire.filter((w) => w.status === 429).length,
    count5xx: wire.filter((w) => w.status >= 500).length,
    retriesTotal: Math.max(0, wire.length - requests),
    retryAfterSeen: wire.flatMap((w) => (w.retryAfter ? [w.retryAfter] : [])),
    latencyMinMs: latencyMs.length ? Math.min(...latencyMs) : null,
    latencyMaxMs: latencyMs.length ? Math.max(...latencyMs) : null,
    wallClockMs,
    effectiveRequestsPerMinute:
      wallClockMs > 0 ? Math.round((requests / wallClockMs) * 60_000) : requests * 60,
    note: "PASS evidence for G1_PROVIDER_RATE_BEHAVIOR is: count429 = 0 across a burn at least as long as one plan minute window, matching the provider's published Kokoro-plan cap (documented in docs/providers.md).",
  };
}

function buildStack(config: ServerConfig) {
  const wired = makeInstrumentedFetch(() => {});
  const inner: SpeechProvider =
    config.SPEECH_PROVIDER === "nan"
      ? new NanSpeechProvider({
          baseUrl: config.NAN_BASE_URL as string,
          apiKey: config.NAN_API_KEY as string,
          timeoutMs: config.SPEECH_TIMEOUT_MS,
          fetchFn: wired.fetchFn,
        })
      : new MockSpeechProvider({ latencyMs: 150 });
  const obs = new ObservingProvider(inner, wired.drain);
  const paced = new PacedProvider(obs, {
    maxConcurrency: config.SPEECH_MAX_CONCURRENCY,
    minIntervalMs: Math.ceil(60_000 / config.SPEECH_REQUESTS_PER_MINUTE),
    maxAttempts: config.SPEECH_MAX_ATTEMPTS,
  });
  return { obs, paced };
}

function parseFlags(argv: string[]): {
  samples: number;
  burn: number;
  wiring: boolean;
} {
  let samples = 25;
  let burn = 0;
  let wiring = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--samples") samples = Number(argv[++i]);
    else if (argv[i] === "--burn") burn = Number(argv[++i]);
    else if (argv[i] === "--wiring") wiring = true;
  }
  if (!Number.isInteger(samples) || samples < 1 || samples > 200) {
    throw new Error("--samples must be an integer 1..200");
  }
  if (!Number.isInteger(burn) || burn < 0 || burn > 500) {
    throw new Error("--burn must be an integer 0..500");
  }
  return { samples, burn, wiring };
}

async function main(): Promise<void> {
  const flags = parseFlags(process.argv.slice(2));
  const config = loadConfig();
  const liveRequested = process.env.RUN_LIVE_PROVIDER === "1";

  if (config.SPEECH_PROVIDER !== "nan" && !flags.wiring) {
    console.error(
      "[eval:tts:live] refusing to run: SPEECH_PROVIDER must be `nan` and RUN_LIVE_PROVIDER=1.\n" +
        "               For the offline self-test use: npm run eval:tts:wiring",
    );
    process.exit(2);
  }
  if (config.SPEECH_PROVIDER === "nan" && !liveRequested) {
    console.error(
      "[eval:tts:live] refusing to run: set RUN_LIVE_PROVIDER=1 to confirm you intend\n" +
        "               to spend real provider quota.",
    );
    process.exit(2);
  }
  const isWiring = config.SPEECH_PROVIDER !== "nan";
  if (isWiring) {
    console.warn(
      "[eval:tts:wiring] MOCK PROVIDER — output is a pipeline self-test, NOT G1 evidence.",
    );
  }

  const settings: SpeechRequest["settings"] = {
    provider: config.SPEECH_PROVIDER,
    model: config.NAN_TTS_MODEL,
    voice: config.NAN_TTS_VOICE,
    speed: config.SPEECH_DEFAULT_SPEED,
    format: config.NAN_TTS_FORMAT,
  };
  const { obs, paced } = buildStack(config);
  const samples = collectSamples(flags.samples);
  console.log(
    `[eval:tts] ${samples.length} stratified real chunks, pacing ${config.SPEECH_REQUESTS_PER_MINUTE}/min, serial.`,
  );

  const records: RequestRecord[] = [];
  for (const sample of samples) {
    const rec = await measureRequest(paced, obs, sample, settings);
    records.push(rec);
    console.log(
      `  ${rec.label}: ${rec.ok ? "ok" : `FAIL ${rec.error}`}` +
        ` ttfa=${rec.successfulTtfaMs ?? "-"}ms wire=${rec.successfulAttemptWireMs ?? "-"}ms` +
        ` queue=${rec.queueWaitMs ?? "-"}ms attempts=${rec.attempts}` +
        ` audio=${rec.audioMs ?? "-"}ms rtf=${rec.rtf ?? "-"}`,
    );
  }

  const burn = flags.burn > 0 ? await runBurn(paced, obs, settings, flags.burn) : null;

  const okRecs = records.filter((r) => r.ok);
  const wireStatuses = obs.attempts.flatMap((a) => a.wireEvents.map((w) => w.status));
  const count429 = wireStatuses.filter((s) => s === 429).length;
  const connectivity = okRecs.length > 0;
  const result = {
    generatedAt: new Date().toISOString(),
    evidenceKind: isWiring
      ? "WIRING-SELF-TEST (mock provider) — NEVER cite as G1 evidence"
      : "G1 transport/latency evidence (provider suitability for product use remains a documented human decision)",
    provider: config.SPEECH_PROVIDER,
    model: config.NAN_TTS_MODEL,
    voice: config.NAN_TTS_VOICE,
    format: config.NAN_TTS_FORMAT,
    durationMeasurability:
      config.NAN_TTS_FORMAT === "wav"
        ? "exact (RIFF header)"
        : "null for non-WAV containers — never guessed; set NAN_TTS_FORMAT=wav for full RTF",
    pacing: {
      maxConcurrency: config.SPEECH_MAX_CONCURRENCY,
      requestsPerMinute: config.SPEECH_REQUESTS_PER_MINUTE,
      minIntervalMs: Math.ceil(60_000 / config.SPEECH_REQUESTS_PER_MINUTE),
      maxAttempts: config.SPEECH_MAX_ATTEMPTS,
    },
    gates: {
      G1_PROVIDER_CONNECTIVITY: isWiring
        ? "NOT_MEASURABLE(mock)"
        : connectivity
          ? "PASS"
          : "FAIL",
      G1_PROVIDER_LATENCY: isWiring
        ? "NOT_MEASURABLE(mock)"
        : connectivity
          ? "MEASURED — accept/reject is a human decision on the distribution below"
          : "OPEN",
      G1_PROVIDER_RATE_BEHAVIOR: isWiring
        ? "NOT_MEASURABLE(mock)"
        : burn
          ? burn.count429 === 0 && burn.successes === burn.requests
            ? "PASS at configured pace (0 wire-level 429 — rerun with larger burn near the plan cap for full confidence)"
            : `OPEN — ${burn.count429} wire 429(s) observed`
          : "OPEN — run with --burn N",
    },
    sampleMetrics: {
      requested: samples.length,
      successes: okRecs.length,
      failures: records.length - okRecs.length,
      ttfaFirstAttemptP50Ms: percentile(
        okRecs.map((r) => r.firstAttemptTtfaMs).filter((n): n is number => n !== null),
        0.5,
      ),
      ttfaFirstAttemptP95Ms: percentile(
        okRecs.map((r) => r.firstAttemptTtfaMs).filter((n): n is number => n !== null),
        0.95,
      ),
      wireLatencyP50Ms: percentile(
        okRecs
          .map((r) => r.successfulAttemptWireMs)
          .filter((n): n is number => n !== null),
        0.5,
      ),
      wireLatencyP95Ms: percentile(
        okRecs
          .map((r) => r.successfulAttemptWireMs)
          .filter((n): n is number => n !== null),
        0.95,
      ),
      totalIncludingPacingP50Ms: percentile(
        okRecs.map((r) => r.totalMs),
        0.5,
      ),
      queueWaitP95Ms: percentile(
        okRecs.map((r) => r.queueWaitMs).filter((n): n is number => n !== null),
        0.95,
      ),
      retriesTotal: records.reduce((s, r) => s + r.retries, 0),
      wireRequests: wireStatuses.length,
      count429WireLevel: count429,
      audioSecondsTotal: okRecs.reduce((s, r) => s + (r.audioMs ?? 0), 0) / 1000,
      rtfP50: percentile(
        okRecs.map((r) => r.rtf).filter((n): n is number => n !== null),
        0.5,
      ),
      bytesTotal: okRecs.reduce((s, r) => s + (r.bytes ?? 0), 0),
    },
    records,
    burn,
  };
  const outName = isWiring ? "tts.wiring-smoke.json" : "tts.json";
  writeResult(outName, result);
  console.log(`[eval:tts] wrote evaluation/results/${outName}`);
  if (!isWiring && !connectivity) process.exit(1);
  if (isWiring && records.some((r) => !r.ok)) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
