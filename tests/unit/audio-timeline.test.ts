import { afterEach, expect, it, vi } from "vitest";
import { BufferedAudioEngine } from "@/lib/buffered-audio-engine";
import { BufferedSpeechPlayer } from "@/lib/buffered-player";

class Buffer {
  numberOfChannels = 1;
  constructor(
    public length = 1000,
    public sampleRate = 100,
  ) {}
  get duration() {
    return this.length / this.sampleRate;
  }
  getChannelData() {
    return new Float32Array(this.length).fill(0.5);
  }
}
class Source {
  buffer: Buffer | null = null;
  playbackRate = { value: 1 };
  onended: (() => void) | null = null;
  startAt = Infinity;
  offset = 0;
  stopped = false;
  disconnected = false;
  finished = false;
  connect() {}
  disconnect() {
    this.disconnected = true;
  }
  start(at = 0, offset = 0) {
    this.startAt = at;
    this.offset = offset;
  }
  stop() {
    this.stopped = true;
  }
  get endAt() {
    return (
      this.startAt +
      ((this.buffer?.duration ?? 0) - this.offset) / this.playbackRate.value
    );
  }
}
class Clock {
  static latest: Clock;
  currentTime = 0;
  state = "running";
  destination = {};
  sources: Source[] = [];
  creationCost = 0;
  constructor() {
    Clock.latest = this;
  }
  async resume() {
    this.state = "running";
  }
  async close() {
    this.state = "closed";
  }
  createAnalyser() {
    return { fftSize: 0, connect() {} };
  }
  createBuffer(_channels: number, length: number, rate: number) {
    return new Buffer(length, rate);
  }
  async decodeAudioData() {
    return new Buffer();
  }
  createBufferSource() {
    this.currentTime += this.creationCost;
    const s = new Source();
    this.sources.push(s);
    return s;
  }
  advance(seconds: number) {
    this.currentTime += seconds;
    for (const s of [...this.sources])
      if (!s.stopped && !s.finished && s.endAt <= this.currentTime) {
        s.finished = true;
        s.onended?.();
      }
  }
  begin() {
    const start = Math.min(
      ...this.sources.filter((s) => !s.stopped && !s.finished).map((s) => s.startAt),
    );
    if (Number.isFinite(start) && start > this.currentTime)
      this.advance(start - this.currentTime);
  }
  get audible() {
    return this.sources.filter(
      (s) =>
        !s.stopped &&
        !s.finished &&
        s.startAt <= this.currentTime &&
        s.endAt > this.currentTime,
    );
  }
}
const engines: BufferedAudioEngine[] = [];
async function setup(count = 3) {
  vi.stubGlobal("AudioContext", Clock);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const chunks: number[] = [],
    states: string[] = [];
  const engine = new BufferedAudioEngine({
    onStateChange: (s) => states.push(s),
    onChunkChange: (i) => chunks.push(i),
  });
  engines.push(engine);
  await engine.init();
  engine.setTotalChunks(count);
  for (let i = 0; i < count; i++) await engine.enqueue(i, new Blob(["audio"]));
  engine.play();
  await Promise.resolve();
  Clock.latest.begin();
  return { engine, clock: Clock.latest, chunks, states };
}
afterEach(() => {
  engines.splice(0).forEach((e) => e.destroy());
  vi.unstubAllGlobals();
});

it.each([0.005, 0.05])(
  "source creation taking %ss cannot make adjacent buffers overlap",
  async (cost) => {
    const { engine, clock } = await setup();
    engine.pause();
    clock.creationCost = cost;
    engine.resume();
    await Promise.resolve();
    clock.begin();
    const scheduled = clock.sources.filter((s) => !s.stopped);
    expect(scheduled[1].startAt).toBe(scheduled[0].endAt);
  },
);

it("schedules ahead without reporting the future source as audible", async () => {
  const { clock, chunks } = await setup();
  expect(clock.sources.filter((s) => !s.stopped).length).toBeGreaterThanOrEqual(2);
  expect(clock.sources[1].startAt).toBe(clock.sources[0].endAt);
  expect(clock.sources[2].startAt).toBe(clock.sources[1].endAt);
  clock.advance(1);
  expect(chunks.at(-1)).toBe(0);
  expect(clock.audible).toHaveLength(1);
});
it("pause stops every source, including already scheduled future chunks", async () => {
  const { engine, clock } = await setup();
  clock.advance(1);
  engine.pause();
  expect(clock.sources.every((s) => s.stopped || s.finished)).toBe(true);
  clock.advance(11);
  expect(clock.audible).toHaveLength(0);
  engine.resume();
  await Promise.resolve();
  clock.begin();
  clock.advance(1);
  expect(engine.currentTime).toBeCloseTo(2, 1);
});
it.each([0.75, 1, 1.5, 2])(
  "uses global source time across chunks at %sx",
  async (rate) => {
    const { engine, clock } = await setup();
    engine.setPlaybackRate(rate);
    clock.begin();
    clock.advance(12 / rate);
    expect(engine.currentTime).toBeCloseTo(12, 1);
  },
);
it("seeking while paused stays silent", async () => {
  const { engine, clock } = await setup();
  engine.pause();
  engine.seek(12);
  clock.advance(1);
  expect(clock.audible).toHaveLength(0);
  expect(engine.currentTime).toBe(12);
});
it("destroy silences every source and stale ended callbacks", async () => {
  const { engine, clock, states } = await setup();
  const callbacks = clock.sources.map((s) => s.onended);
  engine.destroy();
  callbacks.forEach((fn) => fn?.());
  clock.advance(15);
  expect(clock.audible).toHaveLength(0);
  expect(states.at(-1)).toBe("idle");
});
it("playing seek replaces every source at the exact target and invalidates stale callbacks", async () => {
  const { engine, clock, states } = await setup();
  clock.advance(3);
  const old = [...clock.sources];
  const callbacks = old.map((s) => s.onended);
  engine.seek(15);
  clock.begin();
  callbacks.forEach((fn) => fn?.());
  expect(old.every((s) => s.stopped)).toBe(true);
  expect(clock.audible).toHaveLength(1);
  expect(clock.audible[0].offset).toBe(5);
  expect(engine.currentTime).toBe(15);
  clock.advance(1);
  expect(engine.currentTime).toBe(16);
  expect(states.at(-1)).toBe("playing");
});

it("natural end emits once, even if ended callbacks are delivered again", async () => {
  const { engine, clock, states } = await setup();
  const callbacks = clock.sources.map((s) => s.onended);
  clock.advance(10);
  expect(engine.currentTime).toBe(10);
  clock.advance(10);
  expect(engine.currentTime).toBe(20);
  clock.advance(10);
  callbacks.forEach((fn) => fn?.());
  expect(engine.currentTime).toBe(30);
  expect(states.filter((s) => s === "ended")).toHaveLength(1);
});

it("eviction preserves historical durations and never inflates the estimate", async () => {
  const { engine, clock } = await setup(3);
  engine.setTotalChunks(12);
  for (let i = 3; i < 12; i++) {
    clock.advance(10);
    await engine.enqueue(i, new Blob(["audio"]));
    expect(engine.decodedCount).toBeLessThanOrEqual(6);
    expect(engine.estimatedDuration).toBe(120);
  }
  expect(engine.hasBuffer(0)).toBe(false);
  expect(engine.chunkTime(10)).toBe(100);
  expect(engine.totalDuration).toBe(120);
  await engine.enqueue(0, new Blob(["audio"]));
  expect(engine.totalDuration).toBe(120);
});

it("boundaries use local source time through pause, resume, seek and speed", async () => {
  const { engine, clock } = await setup();
  engine.setChunkBoundaries(1, {
    index: 1,
    boundaries: [{ word: "obligation", offsetMs: 1000, durationMs: 1000 }],
  });
  clock.advance(11.2);
  expect(engine.getActiveBoundary()?.word).toBe("obligation");
  engine.pause();
  clock.advance(10);
  expect(engine.getActiveBoundary()?.word).toBe("obligation");
  engine.resume();
  await Promise.resolve();
  clock.begin();
  engine.setPlaybackRate(2);
  clock.begin();
  clock.advance(0.2);
  expect(engine.currentTime).toBeCloseTo(11.6);
  expect(engine.getActiveBoundary()?.word).toBe("obligation");
  engine.seek(1);
  expect(engine.getActiveBoundary()).toBeNull();
});

it("real player applies a rate set before engine creation and reuses blobs through playback controls", async () => {
  vi.stubGlobal("AudioContext", Clock);
  vi.stubGlobal("requestAnimationFrame", () => 0);
  const requests: string[] = [];
  const player = new BufferedSpeechPlayer(
    Array.from({ length: 9 }, (_, i) => ({
      id: `c${i}`,
      text: `texto ${i}`,
      segmentIds: [`s${i}`],
    })),
    {
      onStateChange() {},
      onChunkChange() {},
      onMetrics() {},
      onError(code) {
        throw Error(code);
      },
    },
    {
      health: async () => ({
        ok: true,
        provider: "mock",
        model: "mock",
        voice: "es",
        speed: 1,
        format: "wav",
      }),
      fetchImpl: async (_url, init) => {
        requests.push(JSON.parse(String(init?.body)).text);
        return new Response(new Blob(["audio"]));
      },
    },
  );
  try {
    player.setPlaybackRate(1.5);
    await player.play();
    const clock = Clock.latest;
    clock.begin();
    expect(clock.audible[0].playbackRate.value).toBe(1.5);
    clock.advance(1);
    expect(player.elapsed).toBe(1.5);
    player.pause();
    const paused = player.elapsed;
    clock.advance(20);
    expect(clock.audible).toHaveLength(0);
    player.resume();
    await Promise.resolve();
    clock.begin();
    clock.advance(1);
    expect(player.elapsed).toBeCloseTo(paused + 1.5);
    const pendingSeek = player.seekToChunk(7, false);
    expect(clock.audible).toHaveLength(0);
    player.resume();
    await pendingSeek;
    await Promise.resolve();
    clock.begin();
    expect(clock.audible).toHaveLength(1);
    player.pause();
    expect(player.elapsed).toBe(70);
    player.resume();
    await Promise.resolve();
    clock.begin();
    clock.advance(1);
    expect(player.elapsed).toBe(71.5);
    player.setPlaybackRate(2);
    clock.begin();
    clock.advance(1);
    expect(player.elapsed).toBe(73.5);
    await Promise.all(Array.from({ length: 9 }, (_, i) => player.blobFor(i)));
    await Promise.all(Array.from({ length: 9 }, (_, i) => player.blobFor(i)));
    expect(requests).toHaveLength(9);
    expect(new Set(requests).size).toBe(9);
    expect(player.estimatedDuration).toBe(90);
    for (const rate of [0.75, 1.5, 2]) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      player.setPlaybackRate(rate);
      clock.begin();
      expect(clock.audible).toHaveLength(1);
      expect(clock.audible[0].playbackRate.value).toBe(rate);
    }
    player.pause();
    player.seekByTime(42.5);
    player.resume();
    await new Promise<void>((resolve) => setImmediate(resolve));
    clock.begin();
    expect(clock.audible).toHaveLength(1);
    expect(player.elapsed).toBe(42.5);
    player.destroy();
    clock.advance(20);
    expect(clock.audible).toHaveLength(0);
  } finally {
    player.destroy();
  }
});
it("late decode freezes the document clock through an underrun", async () => {
  const { engine, clock } = await setup(1);
  engine.setTotalChunks(3);
  clock.advance(15);
  expect(engine.currentTime).toBe(10);
  await engine.enqueue(1, new Blob(["audio"]));
  clock.begin();
  expect(engine.currentTime).toBe(10);
  clock.advance(1);
  expect(engine.currentTime).toBe(11);
});

it("pause wins over an unresolved play initialization", async () => {
  const { engine, clock } = await setup();
  engine.pause();
  engine.resume();
  engine.pause();
  await Promise.resolve();
  clock.advance(40);
  expect(clock.audible).toHaveLength(0);
  expect(engine.currentState).toBe("paused");
});
