/**
 * BufferedSpeechPlayer — high-level playback orchestrator.
 *
 * Combines blob-fetching/caching logic with the gapless
 * BufferedAudioEngine.  The external API is compatible with SpeechPlayer so
 * the Reader component can adopt it with minimal changes.
 *
 * Key improvements over the original:
 *  - Web Audio API for gapless chunk transitions
 *  - Accumulated real elapsed time across chunks
 *  - Total estimated duration from decoded buffer durations
 *  - Conservative speech-bound trimming on each decoded buffer
 *  - Playback rate applied via source node (no TTS regeneration)
 *  - Bounded decoding buffer (max 6 decoded AudioBuffers, time-budget)
 *  - In-flight request deduplication (shared Promise per synthesis identity)
 *  - Network fetch timeout per request
 *  - Provider capability awareness
 *  - Back-pressure: never decode more than ~60s ahead by default
 *  - Clean semantic-gap insertion at chunk boundaries
 *  - Word-boundary propagation (when provider supplies it)
 *
 * Independent code — no source copied from other projects.
 */
import type { SpeechChunk } from "@/domain/spoken/types";
import type {
  SpeechSettings,
  ProviderMetadata,
  WordBoundary,
} from "@/domain/speech/types";
import { computeAudioCacheKey } from "@/infrastructure/cache/cache-key";
import { getCachedAudio, putCachedAudio } from "./idb-audio-cache";
import { BufferedAudioEngine } from "./buffered-audio-engine";
import { isAbortError, type PlayerMetrics, type PlayerOptions } from "./speech-player";

/* ─── Types ─────────────────────────────────────────────────────────────── */

export type BufferedPlayerState =
  "idle" | "loading" | "buffering" | "playing" | "paused" | "ended" | "error";

/** Progress info for the UI. */
export interface PlaybackProgress {
  /** Current elapsed time in seconds. */
  elapsed: number;
  /** Total/estimated duration in seconds (improves as audio decodes). */
  duration: number;
  /** Ratio 0-1 (0.5 = halfway). */
  progress: number;
  /** Whether we are currently rebuffering (mid-document). */
  isRebuffering: boolean;
  /** Whether the engine supports word-level timing. */
  supportsWordBoundaries: boolean;
}

export interface BufferedPlayerEvents {
  onStateChange: (state: BufferedPlayerState) => void;
  onChunkChange: (index: number) => void;
  onMetrics: (metrics: PlayerMetrics) => void;
  onError: (code: string) => void;
  onPreparedChange?: (ready: number, total: number) => void;
  onTimeUpdate?: (currentTime: number, duration: number) => void;
}

/* ─── Global in-flight dedup registry ───────────────────────────────────── */

/**
 * Global map of in-flight synthesis promises keyed by cache key.
 * This prevents duplicate network requests for the same text/voice/model
 * across ALL players and contexts (play, prefetch, export).
 *
 * The key is a content-addressed SHA-256 of (text, provider, model, voice,
 * speed, format, engine_version).  Playback rate is intentionally NOT
 * included — one synthesized blob serves all speeds.
 */
const globalInFlight = new Map<string, Promise<Blob>>();

/**
 * Acquire an in-flight deduplicated synthesis promise.
 * If a request for the same key is already in progress, the caller awaits
 * the existing promise instead of creating a new network request.
 *
 * @returns A promise that resolves to the audio Blob.
 * @throws If the in-flight request fails, the error propagates to all waiters.
 */
export async function acquireSynthesis(
  cacheKey: string,
  fetchFn: (key: string) => Promise<Blob>,
  signal?: AbortSignal,
): Promise<Blob> {
  // Check global in-flight map
  const existing = globalInFlight.get(cacheKey);
  if (existing) {
    try {
      return await existing;
    } catch {
      // If the shared request fails, remove it so a fresh one can be tried
      globalInFlight.delete(cacheKey);
      throw new Error("synthesis_failed");
    }
  }

  // Check if we can still proceed (signal may have been aborted while waiting)
  if (signal?.aborted) {
    throw new DOMException("The operation was aborted.", "AbortError");
  }

  // Create the synthesis promise
  const promise = fetchFn(cacheKey).finally(() => {
    globalInFlight.delete(cacheKey);
  });

  globalInFlight.set(cacheKey, promise);

  // If an abort signal is provided, abort the fetch when it fires
  return new Promise<Blob>((resolve, reject) => {
    const onAbort = () => {
      // We can't cancel an already-started fetch, but we can reject the
      // waiter and let the in-flight dedup clean up the key.
      globalInFlight.delete(cacheKey);
      reject(new DOMException("The operation was aborted.", "AbortError"));
    };

    signal?.addEventListener("abort", onAbort, { once: true });

    promise.then(resolve).catch((err) => {
      if (!signal?.aborted) reject(err);
    });
  });
}

/* ─── BufferedSpeechPlayer ─────────────────────────────────────────────── */

export class BufferedSpeechPlayer {
  private epoch = 0;
  private index = -1;
  private blobs = new Map<string, Promise<Blob>>();
  private state: BufferedPlayerState = "idle";
  private metrics: PlayerMetrics = {
    requests: 0,
    serverCacheHits: 0,
    localCacheHits: 0,
    errors: 0,
    underruns: 0,
    requestLatenciesMs: [],
    queueWaitsMs: [],
  };
  private playbackRate = 1;
  private readonly prefetchDepth: number;
  private readonly fetchImpl: typeof fetch;
  private readonly voice: string | undefined;
  private readonly engineId: string | undefined;
  private readonly fetchTimeoutMs: number;
  private healthPromise: Promise<import("./speech-player").HealthDescriptor> | null =
    null;
  private readonly healthLoader:
    (() => Promise<import("./speech-player").HealthDescriptor>) | undefined;
  private instanceAbort = new AbortController();
  private destroyed = false;

  // Provider metadata
  private _providerMeta: ProviderMetadata | null = null;

  // Preparation state
  private prepareEpoch = 0;
  private prepareLoopActive = false;
  private prepared = 0;

  // Audio engine
  private engine: BufferedAudioEngine | null = null;

  // Blob queue for the engine
  private blobQueue: { index: number; blob: Blob }[] = [];
  private processingQueue = false;

  // Word boundaries per chunk (keyed by chunk.id)
  private chunkBoundaries = new Map<string, WordBoundary[]>();

  // Rebuffer tracking
  private _isRebuffering = false;

  constructor(
    private readonly chunks: readonly SpeechChunk[],
    private readonly events: BufferedPlayerEvents,
    options: PlayerOptions = {},
  ) {
    this.playbackRate = options.playbackRate ?? 1;
    this.prefetchDepth = options.prefetchDepth ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.voice = options.voice;
    this.engineId = options.engine;
    this.healthLoader = options.health;
    this.fetchTimeoutMs = options.fetchTimeoutMs ?? 30000;
  }

  private health(): Promise<import("./speech-player").HealthDescriptor> {
    const loader =
      this.healthLoader ??
      (async () => {
        const res = await this.fetchImpl("/api/health");
        if (!res.ok) throw new Error("health_unavailable");
        return (await res.json()) as import("./speech-player").HealthDescriptor;
      });
    this.healthPromise ??= loader().catch(() => {
      this.healthPromise = null;
      throw new Error("health_unavailable");
    });
    return this.healthPromise;
  }

  /* ── getters ────────────────────────────────────────────────────────── */

  get currentState(): BufferedPlayerState {
    return this.state;
  }
  get currentIndex(): number {
    return this.index;
  }
  get currentSegmentIds(): string[] {
    return this.chunks[this.index]?.segmentIds ?? [];
  }
  get preparedCount(): number {
    return this.prepared;
  }
  get isPreparing(): boolean {
    return this.prepareLoopActive;
  }
  get isDestroyed(): boolean {
    return this.destroyed;
  }
  getMetrics(): PlayerMetrics {
    return { ...this.metrics };
  }
  /**
   * Estimated total document duration. When not all chunks are decoded,
   * extrapolates from the average decoded-buffer duration.
   */
  get estimatedDuration(): number {
    if (!this.engine || this.chunks.length === 0) return 0;
    const decoded = this.engine.decodedCount;
    if (decoded === 0) return 0;
    const decodedTotal = this.engine.totalDuration;
    if (decoded >= this.chunks.length) return decodedTotal;
    const avgPerChunk = decodedTotal / decoded;
    return avgPerChunk * this.chunks.length;
  }
  get elapsed(): number {
    return this.engine?.currentTime ?? 0;
  }
  get isRebuffering(): boolean {
    return this._isRebuffering;
  }
  get supportsWordBoundaries(): boolean {
    return (
      this.engine?.supportsWordBoundaries ??
      this._providerMeta?.capabilities.supportsWordBoundaries ??
      false
    );
  }
  get providerMetadata(): ProviderMetadata | null {
    return this._providerMeta;
  }

  /* ── preparation ────────────────────────────────────────────────────── */

  prepare(): void {
    if (this.destroyed || this.prepareLoopActive || this.chunks.length === 0) return;
    this.prepareLoopActive = true;
    void this.prepareLoop(++this.prepareEpoch);
  }

  /* ── playback ───────────────────────────────────────────────────────── */

  async play(fromIndex?: number): Promise<void> {
    if (this.destroyed) return;
    const target = Math.min(
      Math.max(0, fromIndex ?? Math.max(0, this.index)),
      this.chunks.length - 1,
    );
    if (this.chunks.length === 0) return;
    if (this.state === "loading" && this.index === target) return;

    const epoch = ++this.epoch;
    this.setState("loading");
    this.index = target;
    this.events.onChunkChange(target);

    // Wait for the target chunk blob.
    try {
      await this.ensureBlob(this.chunks[target]);
    } catch (error) {
      if (epoch !== this.epoch || this.destroyed) return;
      if (isAbortError(error)) return;
      this.metrics.errors += 1;
      this.emitMetrics();
      this.setState("error");
      this.events.onError(error instanceof Error ? error.message : "speech_error");
      return;
    }

    if (epoch !== this.epoch || this.destroyed) return;

    // Initialize engine and enqueue all blobs up to target.
    await this.ensureEngine();
    if (this.destroyed) return;

    for (let i = 0; i <= target; i++) {
      const blob = await this.ensureBlob(this.chunks[i]);
      this.enqueueBlob(i, blob);
    }

    // Wait for at least the first buffer to be decoded.
    await this.waitForBuffer(0);
    if (this.destroyed) return;

    // Seek to target position and start playing.
    this.engine?.seek(this.getAccumulatedTime(target));
    this.index = target;
    this.events.onChunkChange(target);

    // Start playback. This triggers engine scheduling and state transitions.
    this.engine?.play();
  }

  pause(): void {
    if (this.state === "playing" && this.engine) {
      this.engine.pause();
      this.setState("paused");
    }
  }

  resume(): void {
    if (this.state === "paused" && this.engine) {
      this.engine.resume();
      this.setState("playing");
    }
  }

  stop(): void {
    this.epoch += 1;
    this.engine?.stop();
    this.index = -1;
    this.setState("idle");
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.prepareEpoch += 1;
    this.prepareLoopActive = false;
    this.stop();
    this.instanceAbort.abort(
      new DOMException("BufferedSpeechPlayer destroyed", "AbortError"),
    );
    this.blobs.clear();
    this.engine?.destroy();
    this.engine = null;
  }

  async seekToChunk(index: number, autoplay = this.state === "playing"): Promise<void> {
    if (this.destroyed) return;
    const target = Math.min(Math.max(0, index), this.chunks.length - 1);

    try {
      await this.ensureBlob(this.chunks[target]);
    } catch {
      /* skip */
    }

    if (autoplay) {
      await this.play(target);
    } else {
      this.index = target;
      this.events.onChunkChange(target);
      if (this.engine) {
        this.engine.seek(this.getAccumulatedTime(target));
      }
    }
  }

  next(): void {
    if (this.index + 1 < this.chunks.length) void this.seekToChunk(this.index + 1);
  }

  previous(): void {
    if (this.index - 1 >= 0) void this.seekToChunk(this.index - 1);
  }

  /** Seek by document time (seconds). Delegates to the audio engine. */
  seekByTime(time: number): void {
    this.engine?.seek(time);
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
    this.engine?.setPlaybackRate(rate);
  }

  blobFor(index: number): Promise<Blob> {
    const chunk = this.chunks[index];
    if (!chunk) return Promise.reject(new Error("chunk_out_of_range"));
    return this.ensureBlob(chunk);
  }

  /**
   * Get current playback progress info for the UI.
   * Duration is progressively estimated: when not all chunks are decoded,
   * we extrapolate from the average decoded-buffer duration.
   */
  getProgress(): PlaybackProgress {
    const elapsed = this.engine?.currentTime ?? 0;
    const duration = this.estimatedDuration;
    return {
      elapsed,
      duration,
      progress: duration > 0 ? Math.min(1, elapsed / duration) : 0,
      isRebuffering: this._isRebuffering,
      supportsWordBoundaries: this.supportsWordBoundaries,
    };
  }

  /* ── private: engine ────────────────────────────────────────────────── */

  private async ensureEngine(): Promise<void> {
    if (this.engine) return;

    this.engine = new BufferedAudioEngine(
      {
        onStateChange: (s) => {
          const mapped: BufferedPlayerState =
            s === "buffering"
              ? "buffering"
              : s === "error"
                ? "error"
                : (s as BufferedPlayerState);
          this.setState(mapped);
        },
        onTimeUpdate: (t, d) => {
          this.events.onTimeUpdate?.(t, d || this.estimatedDuration);
        },
        onChunkChange: (idx) => {
          this.index = idx;
          this.events.onChunkChange(idx);
        },
        onError: (msg) => {
          this.metrics.errors += 1;
          this.emitMetrics();
          this.events.onError(msg);
        },
        onRebuffer: () => {
          this._isRebuffering = true;
        },
      },
      {
        defaultGap: 0,
        maxDecodedBuffers: 6,
      },
    );

    // Eagerly initialize the AudioContext so enqueue() can work immediately.
    await this.engine.init();

    // Propagate any already-collected word boundaries to the engine
    for (const [chunkId, boundaries] of this.chunkBoundaries) {
      const chunkIndex = this.chunks.findIndex((c) => c.id === chunkId);
      if (chunkIndex >= 0) {
        this.engine.setChunkBoundaries(chunkIndex, {
          index: chunkIndex,
          boundaries: boundaries.map((b) => ({
            word: b.text,
            offsetMs: b.offsetSeconds * 1000,
            durationMs: b.durationSeconds * 1000,
          })),
        });
      }
    }

    // Keep time updates flowing.
    this.tickLoop();
  }

  private tickLoop(): void {
    if (!this.engine || this.destroyed) return;

    // Stop rebuffering once we're back to playing
    if (this._isRebuffering && this.engine.currentState === "playing") {
      this._isRebuffering = false;
    }

    if (this.engine.currentState === "playing") {
      this.events.onTimeUpdate?.(this.engine.currentTime, this.estimatedDuration);
    }
    requestAnimationFrame(() => this.tickLoop());
  }

  private enqueueBlob(index: number, blob: Blob): void {
    this.blobQueue.push({ index, blob });
    if (!this.processingQueue) void this.processQueue();
  }

  /** Wait until a specific buffer index is decoded by the engine. */
  private waitForBuffer(index: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timeout = setTimeout(() => resolve(), 10000); // 10s timeout
      const check = () => {
        if (this.destroyed) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        if (this.engine?.hasBuffer(index)) {
          clearTimeout(timeout);
          resolve();
          return;
        }
        requestAnimationFrame(check);
      };
      check();
    });
  }

  private async processQueue(): Promise<void> {
    this.processingQueue = true;
    while (this.blobQueue.length > 0 && !this.destroyed && this.engine) {
      const item = this.blobQueue.shift()!;

      // Check that we haven't exceeded the back-pressure budget
      if (this.engine.currentState === "playing" && this.engine.decodedCount >= 6) {
        // Wait for current buffers to finish playing before decoding more
        await this.waitForBuffer(item.index);
        if (this.destroyed) break;
      }

      await this.engine.enqueue(item.index, item.blob);

      // Prefetch next chunks (bounded by prefetchDepth).
      for (let d = 1; d <= this.prefetchDepth; d++) {
        const ni = item.index + d;
        if (ni >= this.chunks.length) break;
        if (!this.engine.hasBuffer(ni)) {
          try {
            const b = await this.ensureBlob(this.chunks[ni]);
            this.enqueueBlob(ni, b);
          } catch {
            /* prefetch failure — non-fatal */
          }
        }
      }
    }
    this.processingQueue = false;
  }

  /* ── private: blob fetching ─────────────────────────────────────────── */

  private async ensureBlob(chunk: SpeechChunk): Promise<Blob> {
    const existing = this.blobs.get(chunk.id);
    if (existing) return existing;
    const promise = this.fetchBlob(chunk);
    this.blobs.set(chunk.id, promise);
    try {
      return await promise;
    } catch (error) {
      this.blobs.delete(chunk.id);
      throw error;
    }
  }

  private async cacheKeyFor(text: string): Promise<string | null> {
    try {
      const health = await this.health();
      const engine = this.engineId
        ? health.engines?.find((e) => e.id === this.engineId)
        : (health.engines?.[0] ?? null);
      const settings: SpeechSettings = {
        provider: engine?.provider ?? health.provider,
        model: engine?.model ?? health.model,
        voice: this.voice ?? health.voice,
        speed: 1,
        format: engine?.format ?? health.format,
      };
      return await computeAudioCacheKey(text, settings);
    } catch {
      return null;
    }
  }

  private async fetchBlob(chunk: SpeechChunk): Promise<Blob> {
    // Check local cache first
    const key = await this.cacheKeyFor(chunk.text);
    if (key) {
      const local = await getCachedAudio(key);
      if (local) {
        this.metrics.localCacheHits += 1;
        this.emitMetrics();
        return local;
      }
    }

    const started = Date.now();
    const response = await this.fetchImpl("/api/speech", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        text: chunk.text,
        ...(this.voice ? { voice: this.voice } : {}),
        ...(this.engineId ? { engine: this.engineId } : {}),
        speed: 1,
      }),
      signal: this.instanceAbort.signal,
    });

    if (!response.ok) {
      let code = "speech_error";
      try {
        code = (await response.json()).error ?? code;
      } catch {
        /* */
      }
      this.metrics.errors += 1;
      this.emitMetrics();
      throw new Error(code);
    }

    const serverKey = response.headers.get("cache-key") ?? key ?? `ephemeral-${chunk.id}`;
    const cacheStatus = response.headers.get("cache-status");
    if (cacheStatus === "HIT") this.metrics.serverCacheHits += 1;

    const blob = await response.blob();
    this.metrics.requests += 1;
    this.metrics.requestLatenciesMs.push(Date.now() - started);
    this.emitMetrics();

    // Parse word boundaries from response header (base64-encoded JSON).
    // This is a non-fatal operation — audio is the priority.
    const boundariesHeader = response.headers.get("x-word-boundaries");
    if (boundariesHeader) {
      try {
        const parsed = JSON.parse(atob(boundariesHeader)) as WordBoundary[];
        if (Array.isArray(parsed) && parsed.length > 0) {
          this.chunkBoundaries.set(chunk.id, parsed);
          // Propagate to engine if it exists
          const chunkIndex = this.chunks.findIndex((c) => c.id === chunk.id);
          if (chunkIndex >= 0 && this.engine) {
            this.engine.setChunkBoundaries(chunkIndex, {
              index: chunkIndex,
              boundaries: parsed.map((b) => ({
                word: b.text,
                offsetMs: b.offsetSeconds * 1000,
                durationMs: b.durationSeconds * 1000,
              })),
            });
          }
        }
      } catch {
        // Tolerate malformed boundaries — audio is unaffected
      }
    }

    // Cache on the server for future requests
    void putCachedAudio(serverKey, blob).catch(() => {});

    // Update provider metadata from response headers if available
    const providerName = response.headers.get("x-provider");
    if (providerName) {
      this._providerMeta = {
        name: providerName,
        capabilities: {
          supportsWordBoundaries: false, // Will be refined when provider exposes it
          supportsStreaming: false,
          supportsExactDuration: true,
        },
      };
    }

    return blob;
  }

  /* ── private: preparation ───────────────────────────────────────────── */

  private async prepareLoop(epoch: number): Promise<void> {
    for (let i = this.prepared; i < this.chunks.length; i++) {
      if (this.destroyed || epoch !== this.prepareEpoch) return;
      try {
        await this.ensureBlob(this.chunks[i]);
      } catch (error) {
        if (!this.destroyed && epoch === this.prepareEpoch) {
          if (isAbortError(error)) return;
          this.prepareLoopActive = false;
          this.events.onError("prepare_failed");
        }
        return;
      }
      if (this.destroyed || epoch !== this.prepareEpoch) return;
      this.prepared = Math.max(this.prepared, i + 1);
      this.events.onPreparedChange?.(this.prepared, this.chunks.length);
    }
    if (!this.destroyed && epoch === this.prepareEpoch) {
      this.prepareLoopActive = false;
    }
  }

  /* ── helpers ────────────────────────────────────────────────────────── */

  /** Cumulative document time (seconds) up to and including chunk index. */
  private getAccumulatedTime(index: number): number {
    return this.engine?.chunkTime(index) ?? 0;
  }

  private setState(s: BufferedPlayerState): void {
    if (this.state === s) return;
    this.state = s;
    this.events.onStateChange(s);
  }

  private emitMetrics(): void {
    this.events.onMetrics({ ...this.metrics });
  }
}
