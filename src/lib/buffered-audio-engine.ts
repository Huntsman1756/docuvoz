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

const DEFAULT_GAP = 0;
const DEFAULT_MAX_BUFFERS = 6;
const DEFAULT_MAX_AHEAD_SEC = 60;
const DEFAULT_SILENCE_THRESH = 0.002;
const DEFAULT_FADE_MS = 5;
const DEFAULT_HEAD_PAD_MS = 20;
const DEFAULT_TAIL_PAD_MS = 50;

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

interface ChunkSlot {
  index: number;
  buffer: AudioBuffer;
  duration: number;
}

export class BufferedAudioEngine {
  private ctx: AudioContext | null = null;
  private state: AudioEngineState = "idle";
  private analyser: AnalyserNode | null = null;

  // Decoded buffer pool (bounded)
  private pool: Map<number, ChunkSlot> = new Map();

  // Scheduling state
  private nextIndex = 0;
  private _totalDuration = 0;

  // Playback state
  private source: AudioBufferSourceNode | null = null;
  private sourceStartCtx = 0;
  private playingBuf: AudioBuffer | null = null;
  private playingIdx = -1;
  private playingOffset = 0;
  private playingRate = 1;
  private rate = 1;

  // Gapless scheduling: AudioContext time when the next source should start
  private nextStartTime = 0;
  // Generation counter: incremented on seek/pause/stop to invalidate pending proactive timers
  private scheduleGeneration = 0;

  // Back-pressure
  private _decodedAheadSec = 0;

  // Word boundary tracking
  private wordBoundaryIndex = -1;
  private lastBoundaryCtxTime = 0;

  // Abort
  private decodeAbort = new AbortController();

  // Config
  private readonly sentenceGap: number;
  private readonly paragraphGap: number;
  private readonly sectionGap: number;
  private readonly defaultGap: number;
  private readonly maxAheadSec: number;
  private readonly maxPool: number;
  private readonly silenceThresh: number;
  private readonly fadeMs: number;
  private readonly headPadMs: number;
  private readonly tailPadMs: number;
  private readonly capabilities: ProviderCapabilities;
  private readonly chunkBoundariesMap: Map<number, ChunkBoundaries>;

  // Events
  private ev: AudioEngineEvents;
  private destroyed = false;

  constructor(ev: AudioEngineEvents, opts?: BufferedAudioEngineOptions) {
    this.ev = ev;
    this.sentenceGap = opts?.sentenceGap ?? 0.1;
    this.paragraphGap = opts?.paragraphGap ?? 0.25;
    this.sectionGap = opts?.sectionGap ?? 0.4;
    this.defaultGap = opts?.defaultGap ?? DEFAULT_GAP;
    this.maxAheadSec = opts?.maxAheadSec ?? DEFAULT_MAX_AHEAD_SEC;
    this.maxPool = opts?.maxDecodedBuffers ?? DEFAULT_MAX_BUFFERS;
    this.silenceThresh = opts?.silenceThresh ?? DEFAULT_SILENCE_THRESH;
    this.fadeMs = opts?.fadeMs ?? DEFAULT_FADE_MS;
    this.headPadMs = opts?.headPadMs ?? DEFAULT_HEAD_PAD_MS;
    this.tailPadMs = opts?.tailPadMs ?? DEFAULT_TAIL_PAD_MS;
    this.capabilities = opts?.providerCapabilities ?? {
      supportsWordBoundaries: false,
      supportsStreaming: false,
      supportsExactDuration: false,
    };
    this.chunkBoundariesMap = opts?.chunkBoundaries ?? new Map();
  }

  /* ── lifecycle ──────────────────────────────────────────────────────── */

  async init(): Promise<void> {
    if (this.ctx == null) {
      this.ctx = new AudioContext();
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") await this.ctx.resume();
  }

  destroy(): void {
    this.destroyed = true;
    this.scheduleGeneration++;
    this.decodeAbort.abort();
    this.stopSource();
    this.pool.clear();
    this._totalDuration = 0;
    this._decodedAheadSec = 0;
    this.nextStartTime = 0;
    if (this.ctx) {
      void this.ctx.close().catch(() => undefined);
      this.ctx = null;
    }
    this.analyser = null;
    this.setState("idle");
  }

  /* ── getters ────────────────────────────────────────────────────────── */

  get currentState(): AudioEngineState {
    return this.state;
  }
  get isBuffering(): boolean {
    return this.state === "buffering";
  }
  hasBuffer(index: number): boolean {
    return this.pool.has(index);
  }
  get decodedCount(): number {
    return this.pool.size;
  }
  get totalDuration(): number {
    return this._totalDuration;
  }

  /** Elapsed document time (seconds). */
  get currentTime(): number {
    if (this.state !== "playing" || !this.source || !this.ctx) return this.playingOffset;
    const elapsed = this.ctx.currentTime - this.sourceStartCtx;
    return this.playingOffset + Math.min(elapsed, this.playingBuf?.duration ?? 0);
  }

  /** Cumulative document time (seconds) of the chunk at `index`.  Returns 0 if not decoded. */
  chunkTime(index: number): number {
    let accum = 0;
    const entries = [...this.pool.values()].sort((a, b) => a.index - b.index);
    for (const slot of entries) {
      if (slot.index >= index) return accum;
      accum += slot.duration + this.gapForIndex(slot.index);
    }
    return accum;
  }

  /** Whether the provider supports word-level timing. */
  get supportsWordBoundaries(): boolean {
    return this.capabilities.supportsWordBoundaries;
  }

  /* ── playback controls ──────────────────────────────────────────────── */

  play(): void {
    if (this.destroyed || this.state === "playing") return;
    void this.init().then(() => {
      if (this.destroyed) return;
      if (this.state === "ended" || this.state === "idle") {
        this.playingOffset = 0;
        this.playingBuf = null;
        this.playingIdx = -1;
        this._totalDuration = 0;
        this.pool.clear();
        this.nextIndex = 0;
        this._decodedAheadSec = 0;
        this.wordBoundaryIndex = -1;
        this.nextStartTime = this.ctx?.currentTime ?? 0;
      }
      this.scheduleNext();
    });
  }

  pause(): void {
    if (this.state !== "playing") return;
    if (this.ctx && this.source && this.playingBuf) {
      this.playingOffset += Math.min(
        this.ctx.currentTime - this.sourceStartCtx,
        this.playingBuf.duration,
      );
    }
    this.scheduleGeneration++;
    this.stopSource();
    this.state = "paused";
    this.ev.onStateChange("paused");
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "playing";
    this.ev.onStateChange("playing");
    // Reset word boundary tracking on resume
    this.wordBoundaryIndex = -1;
    this.lastBoundaryCtxTime = 0;
    // Reset nextStartTime to start from now
    this.nextStartTime = this.ctx?.currentTime ?? 0;
    if (this.playingBuf && this.playingOffset < this.playingBuf.duration) {
      this.scheduleSource(
        this.playingIdx,
        this.playingBuf,
        this.playingOffset,
        this.playingRate,
      );
    } else {
      this.scheduleNext();
    }
  }

  stop(): void {
    this.playingOffset = 0;
    this.playingBuf = null;
    this.playingIdx = -1;
    this._totalDuration = 0;
    this.pool.clear();
    this.nextIndex = 0;
    this._decodedAheadSec = 0;
    this.wordBoundaryIndex = -1;
    this.nextStartTime = 0;
    this.scheduleGeneration++;
    this.stopSource();
    this.setState("idle");
  }

  /** Seek to a document time position (seconds). */
  seek(time: number): void {
    if (this.destroyed) return;
    this.scheduleGeneration++;
    this.state = "seeking";
    this.stopSource();
    this.playingOffset = 0;
    this.playingBuf = null;
    this.playingIdx = -1;
    this.wordBoundaryIndex = -1;
    this.lastBoundaryCtxTime = 0;

    let accum = 0;
    for (const slot of this.pool.values()) {
      if (time >= accum && time < accum + slot.duration) {
        this.playingOffset = time - accum;
        this.playingBuf = slot.buffer;
        this.playingIdx = slot.index;
        this.playingRate = this.rate;
        // Set nextStartTime to start after this chunk ends
        const remainingDur = (slot.duration - this.playingOffset) / this.rate;
        const gap = this.gapForIndex(slot.index);
        this.nextStartTime = (this.ctx?.currentTime ?? 0) + remainingDur + gap;
        this.scheduleSource(slot.index, slot.buffer, this.playingOffset, this.rate);
        this.state = "playing";
        return;
      }
      accum += slot.duration + this.gapForIndex(slot.index);
    }
    // Seek target is beyond decoded range; schedule next available
    this.playingOffset = time;
    this.nextStartTime = this.ctx?.currentTime ?? 0;
    this.scheduleNext();
  }

  /** Change playback rate.  Does NOT trigger TTS regeneration. */
  setPlaybackRate(r: number): void {
    this.rate = r;
    this.playingRate = r;
    if (this.source && this.playingBuf && this.ctx) {
      const offset = Math.min(
        this.ctx.currentTime - this.sourceStartCtx,
        this.playingBuf.duration,
      );
      this.stopSource();
      // Reset nextStartTime for immediate scheduling at new rate
      this.nextStartTime = this.ctx.currentTime;
      this.scheduleSource(this.playingIdx, this.playingBuf, offset, r);
    }
  }

  /* ── blob enqueue ───────────────────────────────────────────────────── */

  async enqueue(index: number, blob: Blob): Promise<void> {
    if (this.destroyed || this.pool.has(index)) return;
    if (!this.ctx) return;

    try {
      if (this.decodeAbort.signal.aborted) return;
      const ab = await blob.arrayBuffer();
      if (this.destroyed) return;

      const buf = await this.ctx.decodeAudioData(ab);
      if (this.destroyed) return;

      // Trim silence with speech-bound detection
      const trimmed = trimSilence(
        this.ctx,
        buf,
        this.silenceThresh,
        this.fadeMs,
        this.headPadMs,
        this.tailPadMs,
      );
      const dur = trimmed.duration;

      this.pool.set(index, { index, buffer: trimmed, duration: dur });
      this._totalDuration += dur;

      // Track decoded-ahead time for back-pressure
      this._decodedAheadSec += dur + this.gapForIndex(index);

      // Evict old buffers beyond maxPool
      while (this.pool.size > this.maxPool) {
        const oldest = this.pool.keys().next().value;
        if (oldest !== undefined) {
          this._decodedAheadSec -=
            this.pool.get(oldest)!.duration + this.gapForIndex(oldest);
          this.pool.delete(oldest);
        }
      }

      // Notify events
      if (this.state === "idle") {
        this.state = "buffering";
        this.ev.onStateChange("buffering");
      }
      if (this.state === "buffering") {
        this.state = "playing";
        this.ev.onStateChange("playing");
      }
      if (this.state === "playing") {
        this.scheduleNext();
      }
    } catch {
      if (!this.destroyed) {
        this.ev.onError?.("decode_error");
      }
    }
  }

  /** Compute gap for a given chunk index based on structural info. */
  private gapForIndex(index: number): number {
    const bounds = this.chunkBoundariesMap.get(index);
    if (bounds && bounds.boundaries.length > 0) {
      // Use last boundary's text to determine structure
      const lastWord = bounds.boundaries[bounds.boundaries.length - 1].word;
      if (lastWord.match(/[.!?\n]$/)) return this.sectionGap;
      if (lastWord.match(/[,;:;]$/)) return this.sentenceGap * 0.5;
      return this.sentenceGap;
    }
    return this.defaultGap;
  }

  /** Get word boundary for the current playback time. */
  getCurrentWordBoundaries(): WordBoundary[] {
    if (!this.supportsWordBoundaries || !this.playingBuf) return [];
    const currentTime = this.currentTime;
    const boundaries = this.chunkBoundariesMap.get(this.playingIdx);
    if (!boundaries) return [];
    return boundaries.boundaries.filter((b) => b.offsetMs / 1000 <= currentTime);
  }

  /**
   * Get the single active boundary at the current playback position.
   * Returns the boundary whose time range contains the current playback time.
   */
  getActiveBoundary(): WordBoundary | null {
    if (!this.playingBuf) return null;
    const currentTime = this.currentTime;
    const boundaries = this.chunkBoundariesMap.get(this.playingIdx);
    if (!boundaries || boundaries.boundaries.length === 0) return null;
    // Walk backwards to find the boundary containing currentTime
    for (let i = boundaries.boundaries.length - 1; i >= 0; i--) {
      const b = boundaries.boundaries[i];
      if (currentTime >= b.offsetMs / 1000) return b;
    }
    return boundaries.boundaries[0];
  }

  /** Set word boundaries for a specific chunk index. */
  setChunkBoundaries(index: number, boundaries: ChunkBoundaries): void {
    this.chunkBoundariesMap.set(index, boundaries);
  }

  /* ── private ────────────────────────────────────────────────────────── */

  private stopSource(): void {
    if (this.source) {
      try {
        this.source.stop();
      } catch {
        /* */
      }
      this.source.disconnect();
      this.source = null;
    }
  }

  private scheduleNext(): void {
    if (this.destroyed || this.state !== "playing") return;

    // Check back-pressure: don't schedule more if we're too far ahead
    if (this._decodedAheadSec > this.maxAheadSec) {
      this.state = "buffering";
      this.ev.onStateChange("buffering");
      this.ev.onRebuffer?.();
      this.waitForBuffer();
      return;
    }

    // Find next chunk to schedule
    let nextIdx = this.playingIdx + 1;
    if (this.playingIdx === -1) nextIdx = 0;

    for (const slot of this.pool.values()) {
      if (slot.index >= nextIdx) {
        this.scheduleSource(slot.index, slot.buffer, 0, this.playingRate);
        return;
      }
    }

    // No more buffers in pool — wait for decode
    this.state = "buffering";
    this.ev.onStateChange("buffering");
    this.ev.onRebuffer?.();
    this.waitForBuffer();
  }

  private scheduleSource(idx: number, buf: AudioBuffer, offset: number, r: number): void {
    if (this.destroyed || !this.ctx) return;

    const gen = this.scheduleGeneration;

    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = r;
    src.connect(this.analyser ?? this.ctx.destination);

    // Use nextStartTime for gapless scheduling (not ctx.currentTime)
    const readOffset = Math.min(offset, buf.duration);
    const startAt = Math.max(this.nextStartTime, this.ctx.currentTime + 0.03);
    src.start(startAt, readOffset);
    this.source = src;
    this.sourceStartCtx = startAt;

    this.playingBuf = buf;
    this.playingIdx = idx;
    this.playingOffset = offset;
    this.playingRate = r;
    this.nextIndex = Math.max(this.nextIndex, idx + 1);

    // Update nextStartTime for the next chunk
    const remainingDur = (buf.duration - readOffset) / r;
    const gap = this.gapForIndex(idx);
    this.nextStartTime = startAt + remainingDur + gap;

    this.ev.onChunkChange?.(idx);
    this.ev.onTimeUpdate?.(this.currentTime, this._totalDuration);

    // Proactive scheduling: trigger scheduleNext BEFORE current source ends
    // This eliminates the gap between chunks caused by onended event latency
    const proactiveDelayMs = Math.max(30, Math.min(500, remainingDur * 0.7 * 1000));
    setTimeout(() => {
      if (this.destroyed || gen !== this.scheduleGeneration) return;
      if (this.state === "playing") this.scheduleNext();
    }, proactiveDelayMs);

    // onended as fallback for document end detection and missed proactive timers
    src.onended = () => {
      if (this.destroyed || gen !== this.scheduleGeneration) return;

      // Compute end position without mutating playingOffset (it will be
      // reset by the next scheduleSource call)
      const endPos = offset + (buf.duration - readOffset);
      this.ev.onTimeUpdate?.(endPos, this._totalDuration);

      const remaining = [...this.pool.values()].some((s) => s.index >= this.nextIndex);
      if (!remaining) {
        this.playingOffset = endPos;
        this.state = "ended";
        this.ev.onStateChange("ended");
        return;
      }
      if (this.state === "playing") this.scheduleNext();
    };

    this.ev.onTimeUpdate?.(this.currentTime, this._totalDuration);
  }

  private waitForBuffer(): void {
    if (this.destroyed) return;
    const check = () => {
      if (this.destroyed) return;
      const next = [...this.pool.values()].find((s) => s.index >= this.nextIndex);
      if (next) {
        this._decodedAheadSec -= next.duration + this.gapForIndex(next.index);
        if (this.state === "buffering") {
          this.state = "playing";
          this.ev.onStateChange("playing");
        }
        this.scheduleNext();
        return;
      }
      requestAnimationFrame(check);
    };
    requestAnimationFrame(check);
  }

  private setState(s: AudioEngineState): void {
    if (this.state === s) return;
    this.state = s;
    this.ev.onStateChange(s);
  }
}
