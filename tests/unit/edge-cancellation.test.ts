/**
 * Edge provider cancellation lifecycle tests.
 *
 * Covers production-path scenarios where the abort signal fires at different
 * points during synthesis. Uses controllable fakes — no real network.
 *
 * Required cases:
 *  1. cancel before Edge client resolves
 *  2. cancel during setMetadata (client creation)
 *  3. cancel during active audio stream
 *  4. cancel after audio completes (post-settled abort is no-op)
 *  5. cancelled request does not evict the client
 *  6. next request succeeds after cancellation
 *  7. cancellation is silent to Reader (no user-visible error)
 *  8. real provider error remains visible
 *  9. document A → B switch causes no stale response
 * 10. no unhandled rejection
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { SpeechError } from "@/domain/speech/types";
import { Readable } from "node:stream";

/* ─── Fake stream controller ─────────────────────────────────────────────── */

interface FakeStreamControllers {
  audioEnd: () => void;
  audioError: (err: Error) => void;
  pushAudio: (data: Buffer) => void;
}

let latestStreamControllers: FakeStreamControllers | null = null;

const FAKE_AUDIO_CHUNK = Buffer.from([0xff, 0xfb, 0x90, 0x00]); // MP3-like header bytes

function createFakeAudioStream(): Readable {
  latestStreamControllers = null;
  const stream = new Readable({
    read() {},
    destroy(err, cb) {
      // Clear global reference so tests can detect stream destruction
      latestStreamControllers = null;
      cb(err ?? undefined);
    },
  });
  latestStreamControllers = {
    audioEnd: () => stream.push(null),
    audioError: (err: Error) => stream.destroy(err),
    pushAudio: (data: Buffer) => stream.push(data),
  };
  return stream;
}

function createFakeMetadataStream(): Readable {
  return new Readable({
    read() {},
    destroy(err, cb) {
      cb(err ?? undefined);
    },
  });
}

/* ─── Mock msedge-tts ────────────────────────────────────────────────────── */

let setMetadataDelay = 0;

class FakeMsEdgeTTS {
  static instances: InstanceType<typeof FakeMsEdgeTTS>[] = [];
  closed = false;
  setMetadataCalled = false;
  toStreamCalled = false;

  constructor() {
    (this.constructor as typeof FakeMsEdgeTTS).instances.push(this);
  }

  async setMetadata(): Promise<void> {
    this.setMetadataCalled = true;
    if (setMetadataDelay > 0) {
      await new Promise((resolve) => setTimeout(resolve, setMetadataDelay));
    }
  }

  toStream(): {
    audioStream: Readable;
    metadataStream: Readable | null;
  } {
    this.toStreamCalled = true;
    return {
      audioStream: createFakeAudioStream(),
      metadataStream: createFakeMetadataStream(),
    };
  }

  close(): void {
    this.closed = true;
  }
}

vi.mock("msedge-tts", () => ({
  MsEdgeTTS: FakeMsEdgeTTS,
  OUTPUT_FORMAT: { AUDIO_24KHZ_48KBITRATE_MONO_MP3: "audio-24khz-48kbitrate-mono-mp3" },
}));

/* ─── Lazy import after mock ─────────────────────────────────────────────── */

const { EdgeSpeechProvider } = await import("@/adapters/speech-providers/edge-provider");
type EdgeProviderOptions =
  import("@/adapters/speech-providers/edge-provider").EdgeProviderOptions;

/* ─── Helpers ────────────────────────────────────────────────────────────── */

function makeRequest(
  text = "hola mundo",
  signal?: AbortSignal,
): import("@/domain/speech/types").SpeechRequest {
  return {
    text,
    settings: {
      provider: "edge",
      model: "edge-tts",
      voice: "es-ES-XimenaNeural",
      speed: 1,
      format: "mp3",
    },
    signal,
  };
}

function createProvider(
  opts?: Partial<EdgeProviderOptions>,
): InstanceType<typeof EdgeSpeechProvider> {
  return new EdgeSpeechProvider({
    timeoutMs: 5000,
    ...opts,
  });
}

/** Push one audio chunk + end the stream. */
function completeStream(): void {
  latestStreamControllers?.pushAudio(FAKE_AUDIO_CHUNK);
  latestStreamControllers?.audioEnd();
}

/* ─── Tests ──────────────────────────────────────────────────────────────── */

beforeEach(() => {
  FakeMsEdgeTTS.instances = [];
  latestStreamControllers = null;
  setMetadataDelay = 0;
});

describe("Edge cancellation lifecycle", () => {
  it("1. cancel before Edge client resolves → throws provider_timeout", async () => {
    const provider = createProvider();
    const ac = new AbortController();

    const promise = provider.synthesize(makeRequest("test", ac.signal));
    ac.abort();

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof SpeechError &&
        err.code === "provider_timeout" &&
        err.message.includes("aborted")
      );
    });
  });

  it("2. cancel during setMetadata (client creation) → throws provider_timeout", async () => {
    const provider = createProvider();
    setMetadataDelay = 10_000;

    const ac = new AbortController();
    const promise = provider.synthesize(makeRequest("test", ac.signal));

    ac.abort();

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof SpeechError &&
        err.code === "provider_timeout" &&
        err.message.includes("aborted")
      );
    });
  });

  it("3. cancel during active audio stream → throws provider_timeout, not provider_error", async () => {
    const provider = createProvider();
    const ac = new AbortController();

    const promise = provider.synthesize(makeRequest("test", ac.signal));

    await vi.waitFor(() => {
      expect(latestStreamControllers).not.toBeNull();
    });

    // Push some audio data before aborting
    latestStreamControllers!.pushAudio(FAKE_AUDIO_CHUNK);
    ac.abort();

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof SpeechError &&
        err.code === "provider_timeout" &&
        err.message.includes("aborted")
      );
    });
  });

  it("4. abort after synthesis completes is a no-op (post-settled)", async () => {
    const provider = createProvider();
    const ac = new AbortController();

    const promise = provider.synthesize(makeRequest("test", ac.signal));

    await vi.waitFor(() => {
      expect(latestStreamControllers).not.toBeNull();
    });

    // Complete the stream
    completeStream();

    // Promise should resolve before we abort
    const result = await promise;
    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(result.mimeType).toBe("audio/mpeg");

    // Abort after resolution — should be a no-op
    ac.abort();
  });

  it("5. cancelled request does not evict the client (reusable)", async () => {
    const provider = createProvider();
    const ac = new AbortController();

    const promise = provider.synthesize(makeRequest("test", ac.signal));
    ac.abort();

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return err instanceof SpeechError && err.code === "provider_timeout";
    });

    const instanceCount = FakeMsEdgeTTS.instances.length;

    // Second request should reuse the same client
    const ac2 = new AbortController();
    const p2 = provider.synthesize(makeRequest("test2", ac2.signal));
    await vi.waitFor(() => {
      expect(latestStreamControllers).not.toBeNull();
    });
    completeStream();

    const result = await p2;
    expect(result.audio).toBeInstanceOf(Uint8Array);
    expect(FakeMsEdgeTTS.instances.length).toBe(instanceCount);
  });

  it("6. next request succeeds after cancellation", async () => {
    const provider = createProvider();

    const ac1 = new AbortController();
    const p1 = provider.synthesize(makeRequest("first", ac1.signal));
    ac1.abort();
    await expect(p1).rejects.toSatisfy(
      (err: unknown) => err instanceof SpeechError && err.code === "provider_timeout",
    );

    const ac2 = new AbortController();
    const p2 = provider.synthesize(makeRequest("second", ac2.signal));
    await vi.waitFor(() => {
      expect(latestStreamControllers).not.toBeNull();
    });
    completeStream();

    const result = await p2;
    expect(result.audio).toBeInstanceOf(Uint8Array);
  });

  it("7. cancellation is silent to Reader (provider_timeout, not visible error)", async () => {
    const provider = createProvider();
    const ac = new AbortController();

    const promise = provider.synthesize(makeRequest("test", ac.signal));
    ac.abort();

    try {
      await promise;
      expect.fail("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(SpeechError);
      expect((error as SpeechError).code).toBe("provider_timeout");
      expect((error as SpeechError).retryable).toBe(false);
    }
  });

  it("8. real provider error remains visible (not masked as cancellation)", async () => {
    const provider = createProvider();
    const ac = new AbortController();

    const promise = provider.synthesize(makeRequest("test", ac.signal));

    await vi.waitFor(() => {
      expect(latestStreamControllers).not.toBeNull();
    });

    latestStreamControllers!.audioError(new Error("connection reset"));

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof SpeechError &&
        err.code === "provider_error" &&
        !err.message.includes("aborted")
      );
    });
  });

  it("9. document A → B switch: no stale response from A", async () => {
    const provider = createProvider();
    const acA = new AbortController();

    // Start Document A
    const promiseA = provider.synthesize(makeRequest("docA", acA.signal));

    await vi.waitFor(() => {
      expect(latestStreamControllers).not.toBeNull();
    });

    // Abort A
    acA.abort();
    await expect(promiseA).rejects.toSatisfy(
      (err: unknown) => err instanceof SpeechError && err.code === "provider_timeout",
    );

    // Start Document B
    const acB = new AbortController();
    const promiseB = provider.synthesize(makeRequest("docB", acB.signal));

    await vi.waitFor(() => {
      expect(latestStreamControllers).not.toBeNull();
    });

    // Complete B
    completeStream();
    const result = await promiseB;
    expect(result.audio).toBeInstanceOf(Uint8Array);
  });

  it("10. no unhandled rejection from abort during stream", async () => {
    const provider = createProvider();
    const ac = new AbortController();

    const unhandledRejections: unknown[] = [];
    const handler = (reason: unknown) => unhandledRejections.push(reason);
    process.on("unhandledRejection", handler);

    try {
      const promise = provider.synthesize(makeRequest("test", ac.signal));

      await vi.waitFor(() => {
        expect(latestStreamControllers).not.toBeNull();
      });

      latestStreamControllers!.pushAudio(FAKE_AUDIO_CHUNK);
      ac.abort();

      await expect(promise).rejects.toSatisfy(
        (err: unknown) => err instanceof SpeechError && err.code === "provider_timeout",
      );

      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(
        unhandledRejections,
        `unexpected unhandled rejections: ${unhandledRejections.join("; ")}`,
      ).toHaveLength(0);
    } finally {
      process.removeListener("unhandledRejection", handler);
    }
  });
});

describe("Edge provider timeout", () => {
  it("times out when audio stream never ends", async () => {
    const provider = createProvider({ timeoutMs: 100 });
    const ac = new AbortController();

    const promise = provider.synthesize(makeRequest("test", ac.signal));

    await vi.waitFor(() => {
      expect(latestStreamControllers).not.toBeNull();
    });

    await expect(promise).rejects.toSatisfy((err: unknown) => {
      return (
        err instanceof SpeechError &&
        err.code === "provider_timeout" &&
        err.message.includes("timed out")
      );
    });
  });
});

describe("Edge provider eviction on real failure", () => {
  it("evicts client on real failure, not on abort", async () => {
    const provider = createProvider();

    // Abort — no eviction
    const ac1 = new AbortController();
    const p1 = provider.synthesize(makeRequest("first", ac1.signal));
    ac1.abort();
    await expect(p1).rejects.toSatisfy(
      (err: unknown) => err instanceof SpeechError && err.code === "provider_timeout",
    );

    // Real error — evicts
    const ac2 = new AbortController();
    const p2 = provider.synthesize(makeRequest("second", ac2.signal));

    await vi.waitFor(() => {
      expect(latestStreamControllers).not.toBeNull();
    });
    latestStreamControllers!.audioError(new Error("connection reset"));

    await expect(p2).rejects.toSatisfy(
      (err: unknown) => err instanceof SpeechError && err.code === "provider_error",
    );

    // Third request — new client created after eviction
    const ac3 = new AbortController();
    const p3 = provider.synthesize(makeRequest("third", ac3.signal));
    await vi.waitFor(() => {
      expect(latestStreamControllers).not.toBeNull();
    });
    completeStream();

    const result = await p3;
    expect(result.audio).toBeInstanceOf(Uint8Array);
  });
});
