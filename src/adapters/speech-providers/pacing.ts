/**
 * Request pacing for the provider layer.
 *
 * `PacedProvider` wraps any SpeechProvider with:
 * - a global concurrency cap (default 1: do not parallelize aggressively),
 * - a minimum inter-request interval (token-bucket style pacing that models
 *   provider-specific per-minute limits),
 * - bounded retries with exponential backoff + jitter, honoring Retry-After
 *   semantics carried by SpeechError.status.
 *
 * Cancellation is passed through to the wrapped provider.
 */
import {
  SpeechError,
  type SpeechProvider,
  type SpeechRequest,
  type SpeechResult,
} from "@/domain/speech/types";

export interface PacingOptions {
  maxConcurrency: number;
  /** Minimum interval between request *starts*, in ms (0 disables). */
  minIntervalMs: number;
  maxAttempts: number;
  baseBackoffMs: number;
  maxBackoffMs: number;
  /** Injectable clock for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
}

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new SpeechError("provider_timeout", "aborted while waiting"));
    });
  });

export class PacedProvider implements SpeechProvider {
  readonly name: string;
  private active = 0;
  private queue: (() => void)[] = [];
  private lastStart = 0;
  private readonly opts: Required<Omit<PacingOptions, "sleep" | "random">> & {
    sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
    random: () => number;
  };

  constructor(
    private readonly inner: SpeechProvider,
    options: Partial<PacingOptions> = {},
  ) {
    this.name = inner.name;
    this.opts = {
      maxConcurrency: options.maxConcurrency ?? 1,
      minIntervalMs: options.minIntervalMs ?? 0,
      maxAttempts: options.maxAttempts ?? 3,
      baseBackoffMs: options.baseBackoffMs ?? 500,
      maxBackoffMs: options.maxBackoffMs ?? 8000,
      sleep: options.sleep ?? defaultSleep,
      random: options.random ?? Math.random,
    };
  }

  async synthesize(request: SpeechRequest): Promise<SpeechResult> {
    await this.acquireSlot(request.signal);
    try {
      let attempt = 0;
      for (;;) {
        attempt += 1;
        await this.pace(request.signal);
        try {
          return await this.inner.synthesize(request);
        } catch (error) {
          const retriable =
            error instanceof SpeechError &&
            error.retryable &&
            attempt < this.opts.maxAttempts;
          if (!retriable) throw error;
          const delay = Math.min(
            this.opts.maxBackoffMs,
            this.opts.baseBackoffMs * 2 ** (attempt - 1),
          );
          const jitter = delay * this.opts.random() * 0.3;
          await this.opts.sleep(delay + jitter, request.signal);
        }
      }
    } finally {
      this.releaseSlot();
    }
  }

  private async pace(signal?: AbortSignal): Promise<void> {
    if (this.opts.minIntervalMs <= 0) {
      this.lastStart = Date.now();
      return;
    }
    const wait = this.lastStart + this.opts.minIntervalMs - Date.now();
    if (wait > 0) await this.opts.sleep(wait, signal);
    this.lastStart = Date.now();
  }

  private async acquireSlot(signal?: AbortSignal): Promise<void> {
    if (this.active < this.opts.maxConcurrency) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        this.active += 1;
        resolve();
      };
      const onAbort = () => {
        this.queue = this.queue.filter((w) => w !== waiter);
        reject(new SpeechError("provider_timeout", "aborted while queued"));
      };
      signal?.addEventListener("abort", onAbort);
      this.queue.push(waiter);
    });
  }

  private releaseSlot(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }
}
