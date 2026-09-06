/**
 * BufferedAudioEngine — Web Audio API gapless playback engine.
 *
 * Decodes audio blobs into AudioBuffers and schedules them on a single
 * AudioContext so consecutive buffers play back-to-back with no gap.
 *
 * Design principles (inspired by mature reader architectures, independently
 * implemented — no source code copied or ported):
 *  - Single AudioContext & destination — no transition clicks between chunks
 *  - Proactive scheduling: next buffer is scheduled BEFORE current ends
 *  - AudioContext clock-based timing (not wall-clock timers)
 *  - Pre-decode next N chunks with bounded back-pressure (time budget)
 *  - Semantic pause at chunk boundaries with configurable depth
 *  - Conservative speech-bound trimming (amplitude-threshold + edge fade)
 *  - Playback-rate changes via source-node replacement (no TTS regen)
 *  - Seek finds the target buffer and schedules from that offset
 *  - Provider capability metadata
 *  - Word-boundary timing passthrough
 *
 * No word-boundary timing is assumed by default; providers that expose it
 * can supply wordBoundaryMs per chunk and the engine will propagate them.
 */

/* ─── Types ─────────────────────────────────────────────────────────────── */

export type AudioEngineState =
  "idle" | "buffering" | "playing" | "paused" | "seeking" | "ended" | "error";

export interface WordBoundary {
  word: string;
  offsetMs: number;
  durationMs: number;
}

export interface ChunkBoundaries {
  index: number;
  boundaries: WordBoundary[];
}

export interface AudioEngineEvents {
  onStateChange: (state: AudioEngineState) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
  onChunkChange?: (index: number) => void;
  onWordBoundary?: (boundary: WordBoundary) => void;
  onError?: (message: string) => void;
  onRebuffer?: () => void;
}

export interface BufferedAudioEngineOptions {
  /** Seconds inserted between chunks for sentence boundaries. */
  sentenceGap?: number;
  /** Seconds inserted between chunks for paragraph boundaries. */
  paragraphGap?: number;
  /** Seconds inserted between chunks for section boundaries. */
  sectionGap?: number;
  /** Default gap when no structural info is known (used when boundaries
   * are absent — typically 0 for gapless). */
  defaultGap?: number;
  /** Maximum seconds of audio to keep decoded ahead. */
  maxAheadSec?: number;
  /** Maximum decoded buffers kept in memory at once. */
  maxDecodedBuffers?: number;
  /** Silence amplitude threshold for speech-bound detection (default 0.002,
   * ~-54 dBFS). Values below this are considered silence. */
  silenceThresh?: number;
  /** Length of sine/cosine crossfade at trimmed edges (ms, default 5). */
  fadeMs?: number;
  /** Minimum speech head padding after silence cut (ms, default 20). */
  headPadMs?: number;
  /** Minimum speech tail padding after silence cut (ms, default 50). */
  tailPadMs?: number;
  /** Provider capabilities. */
  providerCapabilities?: ProviderCapabilities;
  /** Word boundary data per chunk (optional, for read-along). */
  chunkBoundaries?: Map<number, ChunkBoundaries>;
}

export interface ProviderCapabilities {
  supportsWordBoundaries: boolean;
  supportsStreaming: boolean;
  supportsExactDuration: boolean;
}

const DEFAULT_MAX_BUFFERS = 6;
const DEFAULT_MAX_AHEAD_SEC = 60;

/* ─── Helpers ───────────────────────────────────────────────────────────── */

/**
 * Trim near-silence from start/end with speech-bound detection.
 *
 * Steps:
 *  1. Find speech onset/offset using amplitude threshold (avoids decoder
 *     dither/ringing which is ~1e-4 to 1e-3, not zero).
 *  2. Apply head/tail padding to preserve natural attack/release.
 *  3. Apply a sine/cosine crossfade at both trimmed edges to eliminate
 *     clicks from non-zero-crossing cuts.
 *
 * Conservative: if no silence is detected, the buffer is returned as-is.
 */
function trimSilence(
  ctx: AudioContext,
  buf: AudioBuffer,
  thresh = 0.002,
  fadeMs = 5,
  headPadMs = 20,
  tailPadMs = 50,
): AudioBuffer {
  const d = buf.getChannelData(0);
  const sr = buf.sampleRate;

  // Find speech onset (forward scan)
  let lo = 0;
  while (lo < buf.length && Math.abs(d[lo]) < thresh) lo++;
  // Apply head padding
  lo = Math.max(0, lo - Math.round(sr * (headPadMs / 1000)));

  // Find speech offset (backward scan)
  let hi = buf.length - 1;
  while (hi > lo && Math.abs(d[hi]) < thresh) hi--;
  // Apply tail padding
  hi = Math.min(buf.length - 1, hi + Math.round(sr * (tailPadMs / 1000)));

  // If the entire buffer is silence, return it unchanged
  if (lo > hi) return buf;

  const n = hi - lo + 1;
  if (n <= 0) return buf;

  const out = ctx.createBuffer(buf.numberOfChannels, n, buf.sampleRate);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const s = buf.getChannelData(c);
    const o = out.getChannelData(c);
    for (let i = 0; i < n; i++) o[i] = s[lo + i];
  }

  // Apply crossfade at edges to avoid clicks
  const fs = Math.max(1, Math.floor((fadeMs / 1000) * buf.sampleRate));
  for (let i = 0; i < fs && i < n; i++) {
    const t = i / fs;
    for (let c = 0; c < out.numberOfChannels; c++) {
      const o = out.getChannelData(c);
      o[i] *= Math.sin((Math.PI / 2) * t);
      o[n - 1 - i] *= Math.cos((Math.PI / 2) * t);
    }
  }
  return out;
}

/* ─── Engine ────────────────────────────────────────────────────────────── */

interface ScheduledSource {
  node: AudioBufferSourceNode;
  index: number;
  endTime: number;
}

export class BufferedAudioEngine {
  private ctx: AudioContext | null = null;
  private state: AudioEngineState = "idle";
  private pool = new Map<number, AudioBuffer>();
  private durations = new Map<number, number>();
  private gaps = new Map<number, number>();
  private sources = new Set<ScheduledSource>();
  private decoding = new Map<number, Promise<void>>();
  private generation = 0;
  private destroyed = false;
  private intent = false;
  private totalChunks = 0;
  private rate = 1;
  private position = 0;
  private anchorContext = 0;
  private anchorDocument = 0;
  private horizon = 0;
  private nextIndex = 0;
  private audibleIndex = -1;
  private boundaries: Map<number, ChunkBoundaries>;

  constructor(
    private ev: AudioEngineEvents,
    private opts: BufferedAudioEngineOptions = {},
  ) {
    this.boundaries = new Map(opts.chunkBoundaries);
  }
  async init(): Promise<void> {
    if (this.destroyed) return;
    this.ctx ??= new AudioContext();
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }
  get currentState() {
    return this.state;
  }
  get isBuffering() {
    return this.state === "buffering";
  }
  hasBuffer(index: number) {
    return this.pool.has(index);
  }
  get decodedCount() {
    return this.pool.size;
  }
  get knownDurationCount() {
    return this.durations.size;
  }
  get totalDuration() {
    return [...this.durations.entries()].reduce(
      (sum, [i, d]) => sum + d + this.gap(i),
      0,
    );
  }
  get estimatedDuration() {
    const average = this.durations.size ? this.totalDuration / this.durations.size : 0;
    return (
      this.totalDuration + Math.max(0, this.totalChunks - this.durations.size) * average
    );
  }
  setTotalChunks(n: number) {
    this.totalChunks = n;
  }
  get supportsWordBoundaries() {
    return (
      this.opts.providerCapabilities?.supportsWordBoundaries === true ||
      this.boundaries.size > 0
    );
  }
  get currentTime(): number {
    if (!this.intent || !this.ctx || this.state !== "playing") return this.position;
    return Math.min(
      this.horizon,
      this.anchorDocument +
        Math.max(0, this.ctx.currentTime - this.anchorContext) * this.rate,
    );
  }
  chunkTime(index: number): number {
    let time = 0;
    for (let i = 0; i < index; i++) time += (this.durations.get(i) ?? 0) + this.gap(i);
    return time;
  }
  private indexAt(time: number): number {
    let start = 0;
    for (let i = 0; i < this.totalChunks; i++) {
      const duration = this.durations.get(i);
      if (duration === undefined || time < start + duration + this.gap(i)) return i;
      start += duration + this.gap(i);
    }
    return this.totalChunks;
  }
  play(): void {
    if (this.destroyed || this.intent) return;
    if (this.state === "ended") this.position = 0;
    this.intent = true;
    const generation = this.generation;
    void this.init()
      .then(() => {
        if (this.destroyed || generation !== this.generation || !this.intent) return;
        this.restart();
      })
      .catch(() => {
        if (!this.destroyed) this.ev.onError?.("audio_context_error");
      });
  }
  pause(): void {
    if (this.destroyed) return;
    this.position = this.currentTime;
    this.intent = false;
    this.invalidate();
    this.setState("paused");
  }
  resume(): void {
    this.play();
  }
  stop(): void {
    this.intent = false;
    this.invalidate();
    this.position = 0;
    this.audibleIndex = -1;
    this.setState("idle");
  }
  destroy(): void {
    if (this.destroyed) return;
    this.stop();
    this.destroyed = true;
    this.pool.clear();
    this.durations.clear();
    this.gaps.clear();
    this.decoding.clear();
    this.boundaries.clear();
    void this.ctx?.close().catch(() => undefined);
    this.ctx = null;
  }
  seek(time: number, autoplay = this.intent): void {
    if (this.destroyed || !Number.isFinite(time)) return;
    this.invalidate();
    this.position = Math.max(0, Math.min(time, this.estimatedDuration));
    this.intent = autoplay;
    if (autoplay) this.restart();
    else this.setState("paused");
    this.update();
  }
  setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0 || rate === this.rate) return;
    this.position = this.currentTime;
    this.invalidate();
    this.rate = rate;
    if (this.intent) this.restart();
  }
  private invalidate(): void {
    this.generation++;
    for (const source of this.sources) {
      source.node.onended = null;
      try {
        source.node.stop();
      } catch {
        /* already stopped */
      }
      source.node.disconnect();
    }
    this.sources.clear();
  }
  private restart(): void {
    if (!this.ctx || !this.intent || this.destroyed) return;
    this.nextIndex = this.indexAt(this.position);
    this.anchorContext = this.ctx.currentTime + 0.03;
    this.anchorDocument = this.position;
    this.horizon = this.position;
    this.schedule();
  }
  async enqueue(index: number, blob: Blob): Promise<void> {
    if (this.destroyed || this.pool.has(index)) return;
    const existing = this.decoding.get(index);
    if (existing) return existing;
    const work = this.decode(index, blob);
    this.decoding.set(index, work);
    try {
      await work;
    } finally {
      this.decoding.delete(index);
    }
  }
  private async decode(index: number, blob: Blob): Promise<void> {
    await this.init();
    const ctx = this.ctx;
    if (!ctx || this.destroyed) return;
    const raw = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (this.destroyed) return;
    const buffer = trimSilence(
      ctx,
      raw,
      this.opts.silenceThresh,
      this.opts.fadeMs,
      this.opts.headPadMs,
      this.opts.tailPadMs,
    );
    this.durations.set(index, buffer.duration);
    // Compute the gap after this chunk based on the last spoken boundary.
    // A small pause follows section terminators (/.!?\n/), a shorter one
    // follows sentence separators (/,;:/), and nothing follows the final
    // chunk (enforced in gap()).  The gaps map is populated lazily on first
    // decode; subsequent decode calls for the same index are deduplicated by
    // the `decoding` promise map above, so this branch runs once per chunk.
    {
      const last = this.boundaries.get(index)?.boundaries.at(-1)?.word;
      const gap = last
        ? /[.!?\n]$/.test(last)
          ? (this.opts.sectionGap ?? 0.4)
          : /[,;:]$/.test(last)
            ? (this.opts.sentenceGap ?? 0.1) * 0.5
            : (this.opts.sentenceGap ?? 0.1)
        : (this.opts.defaultGap ?? 0);
      this.gaps.set(index, gap);
    }
    this.pool.set(index, buffer);
    while (this.pool.size > (this.opts.maxDecodedBuffers ?? DEFAULT_MAX_BUFFERS)) {
      // Sources retain their buffers independently until stopped/ended. Prefer
      // evicting history; duration knowledge is never derived from residency.
      const victim =
        [...this.pool.keys()].find(
          (i) => i !== index && ![...this.sources].some((s) => s.index === i),
        ) ?? this.pool.keys().next().value;
      if (victim === undefined) break;
      this.pool.delete(victim);
    }
    if (this.intent) this.schedule();
  }
  private schedule(): void {
    if (!this.intent || !this.ctx || this.destroyed) return;
    const ctx = this.ctx;
    // A decode or ended callback can arrive after the audible horizon. Resume
    // from the frozen document position, never count the underrun as speech.
    if (
      this.state === "playing" &&
      this.anchorDocument + (ctx.currentTime - this.anchorContext) * this.rate >
        this.horizon
    ) {
      this.position = this.currentTime;
      this.anchorContext = ctx.currentTime + 0.03;
      this.anchorDocument = this.position;
    }
    if (this.sources.size === 0 && this.state === "buffering") {
      this.anchorContext = ctx.currentTime + 0.03;
      this.anchorDocument = this.position;
      this.horizon = this.position;
    }
    while (
      this.nextIndex < this.totalChunks &&
      this.sources.size < (this.opts.maxDecodedBuffers ?? DEFAULT_MAX_BUFFERS)
    ) {
      if (
        (this.horizon - this.currentTime) / this.rate >=
        (this.opts.maxAheadSec ?? DEFAULT_MAX_AHEAD_SEC)
      )
        break;
      const index = this.nextIndex;
      const buffer = this.pool.get(index);
      if (!buffer) break;
      const start = this.chunkTime(index);
      const offset = Math.max(0, this.position - start);
      const when =
        this.anchorContext +
        (Math.max(start, this.position) - this.anchorDocument) / this.rate;
      const node = ctx.createBufferSource();
      const startAt = Math.max(ctx.currentTime, when);
      // If even the safety lead was consumed, anchor subsequent nodes to the
      // actual scheduled start. Otherwise the next source could overlap this one.
      this.anchorContext += startAt - when;
      node.buffer = buffer;
      node.playbackRate.value = this.rate;
      node.connect(ctx.destination);
      const record = { node, index, endTime: start + buffer.duration };
      const generation = this.generation;
      this.sources.add(record);
      this.nextIndex++;
      this.horizon = record.endTime;
      node.onended = () => {
        node.disconnect();
        if (
          generation !== this.generation ||
          this.destroyed ||
          !this.sources.delete(record)
        )
          return;
        this.position = Math.max(this.position, record.endTime);
        this.update();
        this.schedule();
      };
      node.start(startAt, Math.min(offset, buffer.duration));
    }
    if (this.sources.size) this.setState("playing");
    else if (this.nextIndex >= this.totalChunks && this.totalChunks > 0) {
      this.position = this.chunkTime(this.totalChunks);
      this.intent = false;
      this.setState("ended");
    } else {
      this.position = this.currentTime;
      if (this.state !== "buffering") this.ev.onRebuffer?.();
      this.setState("buffering");
    }
    this.update();
  }
  private gap(index: number): number {
    return index === this.totalChunks - 1 ? 0 : (this.gaps.get(index) ?? 0);
  }
  /** UI observation; never uses a wall-clock timer as the playback clock. */
  update(): void {
    const time = this.currentTime;
    const index = Math.min(this.totalChunks - 1, this.indexAt(time));
    if (index >= 0 && index !== this.audibleIndex) {
      this.audibleIndex = index;
      this.ev.onChunkChange?.(index);
    }
    this.ev.onTimeUpdate?.(time, this.estimatedDuration);
  }
  setChunkBoundaries(index: number, boundaries: ChunkBoundaries): void {
    this.boundaries.set(index, boundaries);
  }
  getCurrentWordBoundaries(): WordBoundary[] {
    const index = this.indexAt(this.currentTime),
      local = this.currentTime - this.chunkTime(index);
    return (
      this.boundaries.get(index)?.boundaries.filter((b) => b.offsetMs / 1000 <= local) ??
      []
    );
  }
  getActiveBoundary(): WordBoundary | null {
    if (this.destroyed || this.state === "idle" || this.totalChunks === 0) return null;
    const index = this.indexAt(this.currentTime),
      local = this.currentTime - this.chunkTime(index);
    return (
      this.boundaries
        .get(index)
        ?.boundaries.find(
          (b) => local >= b.offsetMs / 1000 && local < (b.offsetMs + b.durationMs) / 1000,
        ) ?? null
    );
  }
  private setState(state: AudioEngineState): void {
    if (state === this.state) return;
    this.state = state;
    this.ev.onStateChange(state);
  }
}
