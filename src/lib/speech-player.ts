/**
 * Speech queue / player.
 *
 * Lifecycle model:
 *   current chunk -> playing
 *   next chunk    -> ready (fetched)
 *   next + 1      -> generating (in flight)
 *
 * The queue respects provider pacing server-side (one HTTP call per chunk,
 * sequential-ish generation driven by prefetch depth), supports bounded
 * prefetch, cancellation (epoch tokens + AbortController), deduplication,
 * IndexedDB cache hits, retries handled by the server, seeking and document
 * switching. Latency/queue metrics are recorded, never assumed.
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
}

export interface HealthDescriptor {
  provider: string;
  model: string;
  voice: string;
  speed: number;
  format: string;
}

export interface PlayerOptions {
  /** Explicit voice override; when omitted the server default is used and
   * the cache key is computed to match. */
  voice?: string;
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
  private readonly healthLoader: () => Promise<HealthDescriptor>;
  private healthPromise: Promise<HealthDescriptor> | null = null;
  private activeAbort: AbortController | null = null;

  constructor(
    private readonly chunks: readonly SpeechChunk[],
    private readonly events: PlayerEvents,
    options: PlayerOptions = {},
  ) {
    this.playbackRate = options.playbackRate ?? 1;
    this.prefetchDepth = options.prefetchDepth ?? 2;
    this.fetchImpl = options.fetchImpl ?? fetch.bind(globalThis);
    this.voice = options.voice;
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
  getMetrics(): PlayerMetrics {
    return { ...this.metrics };
  }

  async play(fromIndex = Math.max(0, this.index)): Promise<void> {
    const epoch = ++this.epoch;
    this.activeAbort?.abort();
    this.activeAbort = new AbortController();
    this.setState("loading");
    this.index = fromIndex;
    this.events.onChunkChange(fromIndex);
    await this.playChunkAt(fromIndex, epoch);
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

  /** Stop everything; pending work is discarded via the epoch token. */
  stop(): void {
    this.epoch += 1;
    this.activeAbort?.abort();
    this.activeAbort = null;
    this.audio?.pause();
    this.audio = null;
    this.releaseUrls();
    this.setState("idle");
  }

  destroy(): void {
    this.stop();
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
      if (epoch !== this.epoch) return;
      this.metrics.errors += 1;
      this.emitMetrics();
      this.setState("error");
      this.events.onError(error instanceof Error ? error.message : "speech_error");
      return;
    }
    if (epoch !== this.epoch) return;
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
    if (epoch !== this.epoch) return;
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
        if (epoch === this.epoch) {
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
   * fields override server defaults, omitted fields fall back to them.
   */
  private async cacheKeyFor(text: string): Promise<string | null> {
    try {
      const health = await this.health();
      const settings: SpeechSettings = {
        provider: health.provider,
        model: health.model,
        voice: this.voice ?? health.voice,
        speed: 1,
        format: "wav",
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
        speed: 1,
        format: "wav",
      }),
      signal: this.activeAbort?.signal,
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
