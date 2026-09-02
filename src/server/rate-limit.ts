/**
 * Minimal fixed-window per-key rate limiting. Prototype-grade: in-memory,
 * single process. Documented as such; swap for a shared store if deployed
 * multi-instance.
 */
export class SlidingWindowRateLimiter {
  private hits = new Map<string, { count: number; windowStart: number }>();

  constructor(
    private readonly limitPerMinute: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Returns null when allowed, otherwise seconds until the window resets. */
  check(key: string): number | null {
    const now = this.now();
    const windowStart = Math.floor(now / 60_000) * 60_000;
    const entry = this.hits.get(key);
    if (!entry || entry.windowStart !== windowStart) {
      this.hits.set(key, { count: 1, windowStart });
      this.sweep(now);
      return null;
    }
    entry.count += 1;
    if (entry.count > this.limitPerMinute) {
      return Math.ceil((windowStart + 60_000 - now) / 1000);
    }
    return null;
  }

  private sweep(now: number): void {
    if (this.hits.size < 10_000) return;
    for (const [key, entry] of this.hits) {
      if (now - entry.windowStart > 120_000) this.hits.delete(key);
    }
  }
}
