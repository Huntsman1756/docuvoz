import { describe, expect, it, vi } from "vitest";
import { PacedProvider } from "@/adapters/speech-providers/pacing";
import {
  SpeechError,
  type SpeechProvider,
  type SpeechResult,
} from "@/domain/speech/types";

const ok = (text: string): SpeechResult => ({
  audio: new TextEncoder().encode(text),
  mimeType: "audio/wav",
});

function fakeProvider(behavior: (n: number) => Promise<SpeechResult>): SpeechProvider & {
  calls: () => number;
} {
  let n = 0;
  const active = { current: 0, max: 0 };
  return {
    name: "fake",
    calls: () => n,
    async synthesize(): Promise<SpeechResult> {
      n += 1;
      active.current += 1;
      active.max = Math.max(active.max, active.current);
      try {
        return await behavior(active.current);
      } finally {
        active.current -= 1;
      }
    },
  };
}

const settings = {
  provider: "fake",
  model: "m",
  voice: "v",
  speed: 1,
  format: "wav",
};

describe("PacedProvider", () => {
  it("serializes requests at maxConcurrency = 1", async () => {
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
    const paced = new PacedProvider(inner, { maxConcurrency: 1 });
    await Promise.all([
      paced.synthesize({ text: "a", settings }),
      paced.synthesize({ text: "b", settings }),
      paced.synthesize({ text: "c", settings }),
    ]);
    expect(maxLive).toBe(1);
  });

  it("paces request starts via minInterval", async () => {
    const sleeps: number[] = [];
    const inner = fakeProvider(async () => ok("x"));
    const paced = new PacedProvider(inner, {
      minIntervalMs: 100,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    await paced.synthesize({ text: "a", settings });
    await paced.synthesize({ text: "b", settings });
    expect(sleeps.some((s) => s >= 50)).toBe(true);
  });

  it("retries retryable errors with attempts bounded", async () => {
    let attempts = 0;
    const inner: SpeechProvider = {
      name: "fake",
      async synthesize(): Promise<SpeechResult> {
        attempts += 1;
        if (attempts <= 2) {
          throw new SpeechError("rate_limited", "429", { retryable: true, status: 429 });
        }
        return ok("finally");
      },
    };
    const paced = new PacedProvider(inner, {
      maxAttempts: 3,
      baseBackoffMs: 1,
      sleep: async () => {},
    });
    const result = await paced.synthesize({ text: "a", settings });
    expect(attempts).toBe(3);
    expect(new TextDecoder().decode(result.audio)).toBe("finally");
  });

  it("gives up after maxAttempts", async () => {
    const inner = fakeProvider(async () => {
      throw new SpeechError("provider_error", "boom", { retryable: true });
    });
    const paced = new PacedProvider(inner, {
      maxAttempts: 2,
      baseBackoffMs: 1,
      sleep: async () => {},
    });
    await expect(paced.synthesize({ text: "a", settings })).rejects.toThrow("boom");
    expect(inner.calls()).toBe(2);
  });

  it("does not retry non-retryable errors", async () => {
    const inner = fakeProvider(async () => {
      throw new SpeechError("invalid_request", "bad text");
    });
    const paced = new PacedProvider(inner, { maxAttempts: 4, sleep: async () => {} });
    await expect(paced.synthesize({ text: "a", settings })).rejects.toThrow("bad text");
    expect(inner.calls()).toBe(1);
  });

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
});
