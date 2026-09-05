/**
 * F07 — Deadline model and pacing tests.
 *
 * Uses controlled fake clocks/promises. No wall-clock sleeps.
 */
import { describe, expect, it, vi } from "vitest";
import { PacedProvider } from "@/adapters/speech-providers/pacing";
import {
  SpeechError,
  type SpeechProvider,
  type SpeechResult,
} from "@/domain/speech/types";
import { DEADLINE } from "@/server/config";

const ok = (text: string): SpeechResult => ({
  audio: new TextEncoder().encode(text),
  mimeType: "audio/wav",
});

const settings = {
  provider: "fake",
  model: "m",
  voice: "v",
  speed: 1,
  format: "wav",
};

// ─── PacedProvider: pacing invariant ───────────────────────────────────

describe("PacedProvider pacing invariant", () => {
  it("start[i+1] - start[i] >= minIntervalMs even with concurrency > 1", async () => {
    vi.useFakeTimers();
    try {
      const starts: number[] = [];
      const inner: SpeechProvider = {
        name: "fake",
        async synthesize() {
          starts.push(Date.now());
          return ok("x");
        },
      };
      const paced = new PacedProvider(inner, {
        maxConcurrency: 2,
        minIntervalMs: 100,
      });

      const promises = [
        paced.synthesize({ text: "a", settings }),
        paced.synthesize({ text: "b", settings }),
        paced.synthesize({ text: "c", settings }),
        paced.synthesize({ text: "d", settings }),
      ];

      // Advance time through the pacing waits
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all(promises);

      for (let i = 1; i < starts.length; i++) {
        expect(starts[i] - starts[i - 1]).toBeGreaterThanOrEqual(100);
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it("serializes at maxConcurrency = 1", async () => {
    let live = 0;
    let maxLive = 0;
    const inner: SpeechProvider = {
      name: "fake",
      async synthesize() {
        live += 1;
        maxLive = Math.max(maxLive, live);
        await new Promise((r) => setTimeout(r, 5));
        live -= 1;
        return ok("x");
      },
    };
    const paced = new PacedProvider(inner, {
      maxConcurrency: 1,
      sleep: async () => {},
    });
    await Promise.all([
      paced.synthesize({ text: "a", settings }),
      paced.synthesize({ text: "b", settings }),
      paced.synthesize({ text: "c", settings }),
    ]);
    expect(maxLive).toBe(1);
  });
});

// ─── PacedProvider: queue bounds ───────────────────────────────────────

describe("PacedProvider queue bounds", () => {
  it("rejects when queue is full", async () => {
    const hang: SpeechProvider = {
      name: "fake",
      synthesize: () => new Promise(() => {}),
    };
    const paced = new PacedProvider(hang, {
      maxConcurrency: 1,
      maxQueueLength: 2,
      sleep: async () => {},
    });

    void paced.synthesize({ text: "a", settings }).catch(() => {});
    void paced.synthesize({ text: "b", settings }).catch(() => {});
    void paced.synthesize({ text: "c", settings }).catch(() => {});
    await new Promise((r) => setTimeout(r, 1));

    await expect(paced.synthesize({ text: "d", settings })).rejects.toThrow(/queue full/);
  });

  it("default queue length is 32", async () => {
    const hang: SpeechProvider = {
      name: "fake",
      synthesize: () => new Promise(() => {}),
    };
    const paced = new PacedProvider(hang, {
      maxConcurrency: 1,
      sleep: async () => {},
    });
    const promises: Promise<unknown>[] = [];
    void paced.synthesize({ text: "a", settings }).catch(() => {});
    for (let i = 0; i < 32; i++) {
      promises.push(paced.synthesize({ text: `q${i}`, settings }).catch(() => {}));
    }
    await new Promise((r) => setTimeout(r, 1));
    await expect(paced.synthesize({ text: "overflow", settings })).rejects.toThrow(
      /queue full/,
    );
  });
});

// ─── PacedProvider: cancellation releases slot ─────────────────────────

describe("PacedProvider cancellation", () => {
  it("aborts waiting callers when the signal fires", async () => {
    const controller = new AbortController();
    const hang: SpeechProvider = {
      name: "fake",
      synthesize: () => new Promise(() => {}),
    };
    const paced = new PacedProvider(hang, { maxConcurrency: 1, sleep: vi.fn() });
    void paced.synthesize({ text: "a", settings }).catch(() => {});
    const second = paced.synthesize({ text: "b", settings, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 5));
    controller.abort();
    await expect(second).rejects.toBeInstanceOf(SpeechError);
  });

  it("cancellation while in-progress releases slot", async () => {
    // Request A is in progress and hangs. We abort via the signal, which
    // should cause the inner provider to throw, releasing the slot.
    const controller = new AbortController();
    let innerCallCount = 0;
    const inner: SpeechProvider = {
      name: "fake",
      async synthesize() {
        innerCallCount += 1;
        if (innerCallCount === 1) {
          // First call: hang until abort
          return new Promise<SpeechResult>((_, reject) => {
            const onAbort = () => reject(new SpeechError("provider_timeout", "aborted"));
            controller.signal.addEventListener("abort", onAbort);
          });
        }
        // Subsequent calls succeed immediately
        return ok("ok");
      },
    };
    const paced = new PacedProvider(inner, {
      maxConcurrency: 1,
      maxAttempts: 1,
      sleep: async () => {},
    });

    // Request A takes the slot and hangs
    const pA = paced.synthesize({ text: "a", settings, signal: controller.signal });
    await new Promise((r) => setTimeout(r, 1));

    // Cancel request A — should release the slot
    controller.abort();
    await expect(pA).rejects.toThrow();

    // Request B should now succeed (slot released, inner provider succeeds)
    const rB = await paced.synthesize({ text: "b", settings });
    expect(new TextDecoder().decode(rB.audio)).toBe("ok");
  });

  it("error releases slot for next request", async () => {
    let callCount = 0;
    const sometimesFails: SpeechProvider = {
      name: "fake",
      async synthesize() {
        callCount += 1;
        if (callCount === 1) {
          throw new SpeechError("provider_error", "boom", { retryable: false });
        }
        return ok(`success-${callCount}`);
      },
    };
    const paced = new PacedProvider(sometimesFails, {
      maxConcurrency: 1,
      maxAttempts: 1,
      sleep: async () => {},
    });

    await expect(paced.synthesize({ text: "a", settings })).rejects.toThrow("boom");
    const r2 = await paced.synthesize({ text: "b", settings });
    expect(new TextDecoder().decode(r2.audio)).toBe("success-2");
  });
});

// ─── DEADLINE constants ───────────────────────────────────────────────

describe("DEADLINE constants", () => {
  it("has reasonable defaults", () => {
    expect(DEADLINE.QUEUE_MS).toBe(5000);
    expect(DEADLINE.CONNECT_MS).toBe(10000);
    expect(DEADLINE.FIRST_BYTE_MS).toBe(15000);
    expect(DEADLINE.TOTAL_MS).toBe(60000);
  });

  it("TOTAL >= QUEUE + CONNECT + FIRST_BYTE (deadline hierarchy)", () => {
    expect(DEADLINE.TOTAL_MS).toBeGreaterThanOrEqual(
      DEADLINE.QUEUE_MS + DEADLINE.CONNECT_MS + DEADLINE.FIRST_BYTE_MS,
    );
  });
});
