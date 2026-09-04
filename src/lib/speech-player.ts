/**
 * Speech queue / player.
 *
 * Lifecycle model (Personal Reader v0.3):
 *   prepare()   -> background generation of every chunk, in order, reporting
 *                   progress; superseded/queued play starts the moment its
 *                   chunk resolves. Clicking Play during preparation never
 *                   loses or restarts work: play() simply awaits the SAME
 *                   in-flight blob promise.
 *   play/seek   -> epoch-guarded; a superseded play stops applying its results
 *                   but does NOT abort useful in-flight fetches (they stay in
 *                   the blob map and the IDB/server caches for reuse).
 *   destroy()   -> document switch / unmount: aborts every in-flight fetch
 *                   and silences the audio element immediately.
 *
 * Fetches share one instance-scoped AbortController; cancellation that must
 * actually stop network work goes through destroy(). Server-side pacing and
 * retries stay authoritative — the client issues at most one request per
 * chunk (dedup via `blobs`).
 */
import type { SpeechChunk } from "@/domain/spoken/types";
import type { SpeechSettings } from "@/domain/speech/types";
import { computeAudioCacheKey } from "@/infrastructure/cache/cache-key";
import { getCachedAudio, putCachedAudio } from "./idb-audio-cache";

export type PlayerState = "idle" | "loading" | "playing" | "paused" | "ended" | "error";

export interface PlayerMetrics {
  requests: number;
  serverCacheHits: number;
  localCacheHits: number;
  errors: number;
  underruns: number;
  requestLatenciesMs: number[];
  queueWaitsMs: number[];
}

export interface PlayerEvents {
  onStateChange(state: PlayerState): void;
  onChunkChange(index: number): void;
  onMetrics(metrics: PlayerMetrics): void;
  onError(code: string): void;
  /** Background preparation progress: `ready` consecutive chunks fetched. */
  onPreparedChange?(ready: number, total: number): void;
}

export interface EngineDescriptor {
  /** Client-facing engine id ("default", "premium", ...). */
  id: string;
  label: string;
  /** Server-side identity used in the cache key when this engine is picked. */
  provider: string;
  model: string;
  /** Container the engine serves; format is a per-engine server decision. */
  format: string;
}

export interface HealthDescriptor {
  provider: string;
  model: string;
  voice: string;
  speed: number;
  format: string;
  /** Available engines. Absent on servers older than the engine registry. */
  engines?: EngineDescriptor[];
}

export interface PlayerOptions {
  /** Explicit voice override; when omitted the server default is used and
   * the cache key is computed to match. */
  voice?: string;
  /** Engine id (see EngineDescriptor); omitted = server default engine. */
  engine?: string;
  /** Playback rate applied via the media element (synthesis stays at 1x so
   * one audio artifact serves all speeds). */
  playbackRate?: number;
  prefetchDepth?: number;
  fetchImpl?: typeof fetch;
  /** Server runtime defaults (from /api/health). */
  health?: () => Promise<HealthDescriptor>;
}

export class SpeechPlayer {
  private epoch = 0;
  private index = -1;
  private blobs = new Map<string, Promise<Blob>>();
  private audio: HTMLAudioElement | null = null;
  private objectUrls: string[] = [];
  private state: PlayerState = "idle";
  private metrics: PlayerMetrics = {
    requests: 0,
    serverCacheHits: 0,
    localCacheHits: 0,
    errors: 0,
    underruns: 0,
    requestLatenciesMs: [],
    queueWaitsMs: [],
  };
  private playbackRate: number;
  private readonly prefetchDepth: number;
  private readonly fetchImpl: typeof fetch;
  private readonly voice: string | undefined;
  private readonly engine: string | undefined;
  private readonly healthLoader: () => Promise<HealthDescriptor>;
  private healthPromise: Promise<HealthDescriptor> | null = null;
  /** One controller for the lifetime of this player instance: only
   * destroy() aborts it, so superseded plays keep cached work alive. */
  private readonly instanceAbort = new AbortController();
  private destroyed = false;

  private prepareEpoch = 0;
  private prepareLoopActive = false;
  private prepared = 0;

  constructor(
    private readonly chunks: readonly SpeechChunk[],
    private readonly events: PlayerEvents,
    options: PlayerOptions = {},
  ) {
    this.playbackRate = options.playbackRate ?? 1;
    this.prefetchDepth = options.prefetchDepth ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.voice = options.voice;
    this.engine = options.engine;
    this.healthLoader =
      options.health ??
      (async () => {
        const res = await this.fetchImpl("/api/health");
        if (!res.ok) throw new Error("health_unavailable");
        return (await res.json()) as HealthDescriptor;
      });
  }

  private health(): Promise<HealthDescriptor> {
    this.healthPromise ??= this.healthLoader().catch((error: unknown) => {
      this.healthPromise = null;
      throw error;
    });
    return this.healthPromise;
  }

  get currentState(): PlayerState {
    return this.state;
  }
  get currentIndex(): number {
    return this.index;
  }
  get currentSegmentIds(): string[] {
    return this.chunks[this.index]?.segmentIds ?? [];
  }
  /** Consecutive chunks available from index 0 (preparation progress). */
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
   * Start background generation of the whole document (in order). Idempotent:
   * a second call while preparing is a no-op. Errors stop the loop quietly —
   * playback handles user-visible failures; the reader may retry via play().
   */
  prepare(): void {
    if (this.destroyed || this.prepareLoopActive || this.chunks.length === 0) return;
    this.prepareLoopActive = true;
    void this.prepareLoop(++this.prepareEpoch);
  }

  /** Shared generation layer: player, prefetch and export all resolve through
   * this, so a chunk is fetched at most once per instance. */
  blobFor(index: number): Promise<Blob> {
    const chunk = this.chunks[index];
    if (!chunk) return Promise.reject(new Error("chunk_out_of_range"));
    return this.ensureBlob(chunk);
  }

  /**
   * Play from `fromIndex`, waiting as long as needed for that chunk — this is
   * the queued-intent behaviour: a click during preparation is remembered and
   * auto-starts once the chunk resolves. Re-clicking while already waiting on
   * the same chunk is a no-op (no restart, no lost click).
   */
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
    await this.playChunkAt(target, epoch);
  }

  pause(): void {
    if (this.state === "playing" && this.audio) {
      void this.audio.pause();
      this.setState("paused");
    }
  }

  resume(): void {
    if (this.state === "paused" && this.audio) {
      void this.audio.play();
      this.setState("playing");
    }
  }

  /** Stop playback; in-flight generation continues (cached for reuse). */
  stop(): void {
    this.epoch += 1;
    this.audio?.pause();
    this.audio = null;
    this.releaseUrls();
    this.setState("idle");
  }

  /** Tear the instance down (document switch / unmount): aborts every
   * in-flight fetch and silences audio immediately. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.prepareEpoch += 1;
    this.prepareLoopActive = false;
    this.stop();
    this.instanceAbort.abort();
    this.blobs.clear();
  }

  async seekToChunk(index: number, autoplay = this.state === "playing"): Promise<void> {
    const target = Math.min(Math.max(0, index), this.chunks.length - 1);
    this.epoch += 1;
    this.audio?.pause();
    this.releaseUrls();
    if (autoplay) {
      await this.play(target);
    } else {
      this.index = target;
      this.events.onChunkChange(target);
    }
  }

  next(): void {
    if (this.index + 1 < this.chunks.length) void this.seekToChunk(this.index + 1);
  }

  previous(): void {
    if (this.index - 1 >= 0) void this.seekToChunk(this.index - 1);
  }

  setPlaybackRate(rate: number): void {
    this.playbackRate = rate;
    if (this.audio) this.audio.playbackRate = rate;
  }

  private async prepareLoop(epoch: number): Promise<void> {
    for (let i = this.prepared; i < this.chunks.length; i++) {
      if (this.destroyed || epoch !== this.prepareEpoch) return;
      try {
        await this.ensureBlob(this.chunks[i]);
      } catch {
        if (!this.destroyed && epoch === this.prepareEpoch) {
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

  private async playChunkAt(index: number, epoch: number): Promise<void> {
    if (index >= this.chunks.length) {
      this.setState("ended");
      return;
    }
    const chunk = this.chunks[index];
    const waitStart = Date.now();
    let blob: Blob;
    try {
      blob = await this.ensureBlob(chunk);
    } catch (error) {
      if (epoch !== this.epoch || this.destroyed) return;
      this.metrics.errors += 1;
      this.emitMetrics();
      this.setState("error");
      this.events.onError(error instanceof Error ? error.message : "speech_error");
      return;
    }
    if (epoch !== this.epoch || this.destroyed) return;
    if (index + 1 > this.prepared) {
      this.prepared = index + 1;
      this.events.onPreparedChange?.(this.prepared, this.chunks.length);
    }
    const queueWait = Date.now() - waitStart;
    if (queueWait > 250) {
      this.metrics.queueWaitsMs.push(queueWait);
      this.metrics.underruns += 1;
      this.emitMetrics();
    }
    this.prefetchAhead(index, epoch);

    const url = URL.createObjectURL(blob);
    this.objectUrls.push(url);
    this.audio = new Audio(url);
    this.audio.playbackRate = this.playbackRate;
    this.index = index;
    this.events.onChunkChange(index);
    this.setState("playing");

    const finished = await new Promise<"ended" | "error" | "cancelled">((resolve) => {
      const audio = this.audio;
      if (!audio) return resolve("cancelled");
      audio.onended = () => resolve("ended");
      audio.onerror = () => resolve("error");
      // Without this call the element never starts: `onended` would not fire
      // and the queue would stall after one chunk (regression caught by the
      // e2e suite). A rejected play() (autoplay policy) surfaces as error.
      audio.play().catch(() => resolve("error"));
    });
    if (epoch !== this.epoch || this.destroyed) return;
    if (finished === "error") {
      this.metrics.errors += 1;
      this.emitMetrics();
      this.setState("error");
      this.events.onError("playback_error");
      return;
    }
    if (finished === "ended") {
      this.releaseUrls();
      await this.playChunkAt(index + 1, epoch);
    }
  }

  private prefetchAhead(index: number, epoch: number): void {
    for (let d = 1; d <= this.prefetchDepth; d++) {
      const chunk = this.chunks[index + d];
      if (!chunk) return;
      void this.ensureBlob(chunk).catch((error: unknown) => {
        if (epoch === this.epoch && !this.destroyed) {
          this.metrics.errors += 1;
          this.emitMetrics();
        }
        void error;
      });
    }
  }

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

  /**
   * The key inputs must match exactly what the server uses: request body
   * fields override server defaults, omitted fields fall back to them. With
   * the engine registry the server picks provider/model per engine id, so the
   * descriptor — not the top-level defaults — is the source of truth.
   */
  private async cacheKeyFor(text: string): Promise<string | null> {
    try {
      const health = await this.health();
      const engine = this.engine
        ? health.engines?.find((e) => e.id === this.engine)
        : (health.engines?.[0] ?? null);
      const settings: SpeechSettings = {
        provider: engine?.provider ?? health.provider,
        model: engine?.model ?? health.model,
        voice: this.voice ?? health.voice,
        speed: 1,
        // Format is a per-engine server decision; the client mirrors it in the
        // key (and the server's `cache-key` response header stays authoritative
        // for what we actually store in IndexedDB).
        format: engine?.format ?? health.format,
      };
      return await computeAudioCacheKey(text, settings);
    } catch {
      return null;
    }
  }

  private async fetchBlob(chunk: SpeechChunk): Promise<Blob> {
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
        ...(this.engine ? { engine: this.engine } : {}),
        speed: 1,
        // No `format`: the engine decides the container (see cacheKeyFor).
      }),
      signal: this.instanceAbort.signal,
    });
    if (!response.ok) {
      let code = "speech_error";
      try {
        const body = (await response.json()) as { error?: string };
        code = body.error ?? code;
      } catch {
        /* ignore */
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
    void putCachedAudio(serverKey, blob);
    return blob;
  }

  private releaseUrls(): void {
    for (const url of this.objectUrls) URL.revokeObjectURL(url);
    this.objectUrls = [];
  }

  private setState(state: PlayerState): void {
    if (this.state === state) return;
    this.state = state;
    this.events.onStateChange(state);
  }

  private emitMetrics(): void {
    this.events.onMetrics({ ...this.metrics });
  }
}
