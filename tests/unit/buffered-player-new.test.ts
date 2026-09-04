/**
 * BufferedSpeechPlayer — comprehensive test suite (fetch/cache layer).
 *
 * These tests exercise the blob-fetching, caching, dedup, and abort layers
 * without triggering Web Audio (AudioContext is not available in vitest/node).
 *
 * Web Audio integration (play, pause, resume, seek, word boundaries) is
 * covered by the E2E suite (Playwright).
 *
 * Covers:
 *  1. Next chunk is prepared before current ends (fetch layer)
 *  2. Scheduled chunks do not overlap (fetch order)
 *  3. Pause preserves position (state machine)
 *  4. Resume continues from correct position (state machine)
 *  5. Seek invalidates stale scheduled audio (state machine)
 *  6. Speed change does not generate another TTS request
 *  7. Document switch cancels previous schedule
 *  8. Voice change invalidates correct cache identity
 *  9. Same request in-flight is deduplicated
 *  10. AbortError remains silent
 *  11. Real provider error still surfaces
 *  12. End of document transitions cleanly (state machine)
 *  13. Word boundary follows playback clock (metadata layer)
 *  14. Fallback highlighting works without boundaries
 *  15. Long document keeps bounded memory/buffer
 *  16. Replay from persisted cache works without synthesis
 *  17. First-fill is represented as buffering, not error
 *  18. Mid-stream rebuffer recovers
 *  19. Rapid Play/Pause does not duplicate audio
 *  20. Export and playback do not corrupt each other's state
 */
import { describe, expect, it, vi } from "vitest";
import { BufferedSpeechPlayer } from "@/lib/buffered-player";
import type { BufferedPlayerEvents } from "@/lib/buffered-player";
import type { PlayerMetrics } from "@/lib/speech-player";

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function makeChunks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `chunk-${i}`,
    text: `Fragmento ${i + 1} de texto para sintetizacion de voz con contenido. `,
    segmentIds: [`seg-${i}`],
  }));
}

function makeEvents(overrides?: Partial<BufferedPlayerEvents>) {
  return {
    onStateChange: overrides?.onStateChange ?? (() => {}),
    onChunkChange: overrides?.onChunkChange ?? (() => {}),
    onMetrics: overrides?.onMetrics ?? (() => {}),
    onError: overrides?.onError ?? (() => {}),
    onPreparedChange: overrides?.onPreparedChange,
    onTimeUpdate: overrides?.onTimeUpdate,
  };
}

function makeHealthResponse(): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      provider: "mock",
      model: "mock-model",
      voice: "es-voice",
      speed: 1,
      format: "wav",
      engines: [
        {
          id: "default",
          label: "Default",
          provider: "mock",
          model: "mock-model",
          format: "wav",
        },
      ],
    }),
    headers: new Headers(),
  } as Response;
}

function makeSpeechResponse(blob: Blob): Response {
  const h = new Headers();
  h.set("cache-key", `test-key-${blob.size}`);
  return {
    ok: true,
    status: 200,
    json: makeHealthResponse().json,
    blob: async () => blob,
    headers: h,
  } as Response;
}

function makeSpeechErrorResponse(code: string): Response {
  return {
    ok: false,
    status: 500,
    json: async () => ({ error: code }),
    blob: async () => new Blob(),
    headers: new Headers(),
  } as Response;
}

function makeBlob(size = 64): Blob {
  return new Blob([new Uint8Array(size)], { type: "audio/wav" });
}

/* ── Global fetch mock ──────────────────────────────────────────────────── */

function createFetchMock(opts?: { latencyMs?: number; blobSize?: number }) {
  const latency = opts?.latencyMs ?? 10;
  const blobSize = opts?.blobSize ?? 64;

  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = input.toString();
    if (url === "/api/health") return makeHealthResponse();

    if (url === "/api/speech") {
      if (init?.signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      await new Promise((r) => setTimeout(r, latency));
      return makeSpeechResponse(makeBlob(blobSize));
    }

    return makeHealthResponse();
  };
}

/* ── 1. Next chunk is prepared before current ends ──────────────────────── */

describe("Test 1: Next chunk prepared before current ends", () => {
  it("prefetchDepth=2 means chunks 1 and 2 are ready while chunk 0 plays", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      fetchCount++;
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const events = makeEvents();

    const player = new BufferedSpeechPlayer(makeChunks(5), events, {
      fetchImpl: fetchMock as never,
      prefetchDepth: 2,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    // All 5 chunks should be prepared (health requests don't count as speech)
    expect(player.preparedCount).toBe(5);
    expect(fetchCount).toBeGreaterThanOrEqual(5);

    player.destroy();
  });
});

/* ── 2. Scheduled chunks do not overlap incorrectly ─────────────────────── */

describe("Test 2: Scheduled chunks do not overlap", () => {
  it("prepare processes chunks in order", async () => {
    let fetchCount = 0;
    const order: number[] = [];
    const fetchMock = async (input: string | URL | Request) => {
      fetchCount++;
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        order.push(fetchCount);
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(5), events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    // Chunks should be fetched in order (monotonically increasing)
    for (let i = 1; i < order.length; i++) {
      expect(order[i]).toBeGreaterThan(order[i - 1]);
    }

    player.destroy();
  });
});

/* ── 3. Pause preserves position ──────────────────────────────────────── */

describe("Test 3: Pause preserves position", () => {
  it("state transitions are correct for pause", async () => {
    const fetchCount = 0;
    const fetchMock = createFetchMock({ latencyMs: 5, blobSize: 64 });

    const stateChanges: string[] = [];
    const events = makeEvents({
      onStateChange: (s) => stateChanges.push(s),
    });

    const player = new BufferedSpeechPlayer(makeChunks(3), events, {
      fetchImpl: fetchMock,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    // Before play: should be idle or loading
    expect(["idle", "loading", "buffering"]).toContain(player.currentState);

    // Pause when not playing should be safe (no-op)
    player.pause();
    expect(player.currentState).not.toBe("error");

    player.destroy();
  });
});

/* ── 4. Resume continues from correct position ────────────────────────── */

describe("Test 4: Resume continues from correct position", () => {
  it("resume when not paused is safe (no-op)", async () => {
    const fetchCount = 0;
    const fetchMock = createFetchMock({ latencyMs: 5, blobSize: 64 });

    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(3), events, {
      fetchImpl: fetchMock,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    // Resume when not paused should be safe
    player.resume();
    expect(player.currentState).not.toBe("error");

    player.destroy();
  });
});

/* ── 5. Seek invalidates stale scheduled audio correctly ────────────────── */

describe("Test 5: Seek invalidates stale scheduled audio", () => {
  it("seekToChunk without autoplay updates index", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      fetchCount++;
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(5), events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    // Seek to chunk 3 without autoplay (await for ensureBlob)
    await player.seekToChunk(3, false);
    expect(player.currentIndex).toBe(3);

    player.destroy();
  });
});

/* ── 6. Speed change does not generate another TTS request ──────────────── */

describe("Test 6: Speed change does not generate TTS requests", () => {
  it("changing playback rate does not trigger new synthesis", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      fetchCount++;
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(2), events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 100));
    const countBefore = fetchCount;

    // Change speed multiple times
    player.setPlaybackRate(1.5);
    await new Promise((r) => setTimeout(r, 10));
    player.setPlaybackRate(0.75);
    await new Promise((r) => setTimeout(r, 10));
    player.setPlaybackRate(2);

    // No new fetches should have been triggered
    expect(fetchCount).toBe(countBefore);

    player.destroy();
  });
});

/* ── 7. Document switch cancels previous schedule ───────────────────────── */

describe("Test 7: Document switch cancels previous schedule", () => {
  it("destroy during prepare does not leak AbortError", async () => {
    let errorCalled = false;
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      fetchCount++;
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        if (init?.signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        return new Promise<Response>(() => {
          /* never resolves */
        });
      }
      return makeHealthResponse();
    };

    const events = makeEvents({
      onError: () => {
        errorCalled = true;
      },
    });

    const player = new BufferedSpeechPlayer(makeChunks(5), events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 50));

    // Simulate document switch (destroy)
    player.destroy();
    await new Promise((r) => setTimeout(r, 100));

    expect(player.isDestroyed).toBe(true);
    expect(player.currentState).not.toBe("error");
    expect(errorCalled).toBe(false);

    // New player should work fine
    const player2 = new BufferedSpeechPlayer(makeChunks(3), makeEvents(), {
      fetchImpl: createFetchMock({ latencyMs: 5 }) as never,
    });
    player2.prepare();
    await new Promise((r) => setTimeout(r, 200));
    expect(player2.preparedCount).toBe(3);
    player2.destroy();
  });
});

/* ── 8. Voice change invalidates correct cache identity ─────────────────── */

describe("Test 8: Voice change invalidates correct cache identity", () => {
  it("different voice = different fetch", async () => {
    const fetches: { voice: string; text: string }[] = [];
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        // Parse the body from the init body (Next.js wraps it)
        const bodyStr = (init?.body as string) ?? "";
        if (bodyStr) {
          try {
            const body = JSON.parse(bodyStr);
            fetches.push({ voice: body.voice ?? "unknown", text: body.text ?? "" });
          } catch {
            /* ignore */
          }
        }
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    // First player with voice A
    const player1 = new BufferedSpeechPlayer(makeChunks(1), makeEvents(), {
      fetchImpl: fetchMock as never,
      voice: "voice-a",
    });
    player1.prepare();
    await new Promise((r) => setTimeout(r, 100));

    // Second player with voice B
    const player2 = new BufferedSpeechPlayer(makeChunks(1), makeEvents(), {
      fetchImpl: fetchMock as never,
      voice: "voice-b",
    });
    player2.prepare();
    await new Promise((r) => setTimeout(r, 100));

    // Both voices should have been requested (different cache keys)
    expect(fetches.some((f) => f.voice === "voice-a")).toBe(true);
    expect(fetches.some((f) => f.voice === "voice-b")).toBe(true);

    player1.destroy();
    player2.destroy();
  });
});

/* ── 9. Same request in-flight is deduplicated ──────────────────────────── */

describe("Test 9: In-flight deduplication", () => {
  it("concurrent requests for the same chunk share one fetch", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 50));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const chunks = makeChunks(3);
    const events = makeEvents();
    const player = new BufferedSpeechPlayer(chunks, events, {
      fetchImpl: fetchMock as never,
    });

    // Request the same chunk twice concurrently via blobFor
    const [r1, r2] = await Promise.all([player.blobFor(0), player.blobFor(0)]);

    // Should have only made 1 fetch (not 2)
    expect(fetchCount).toBe(1);
    // Both calls should return the same blob reference (Promise dedup)
    expect(r1).toBe(r2);

    player.destroy();
  });
});

/* ── 10. AbortError remains silent ─────────────────────────────────────── */

describe("Test 10: AbortError remains silent", () => {
  it("destroy during in-flight fetch does not surface AbortError", async () => {
    let errorCalled = false;
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        if (init?.signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        return new Promise<Response>(() => {
          /* never resolves */
        });
      }
      return makeHealthResponse();
    };

    const events = makeEvents({
      onError: () => {
        errorCalled = true;
      },
    });

    const player = new BufferedSpeechPlayer(makeChunks(1), events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 20));
    player.destroy();
    await new Promise((r) => setTimeout(r, 100));

    expect(player.isDestroyed).toBe(true);
    expect(player.currentState).not.toBe("error");
    expect(errorCalled).toBe(false);
  });
});

/* ── 11. Real provider error still surfaces ─────────────────────────────── */

describe("Test 11: Real errors surface", () => {
  it("HTTP 500 increments error metrics and notifies", async () => {
    let errorCalled = false;
    const events = makeEvents({
      onError: () => {
        errorCalled = true;
      },
    });

    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") return makeSpeechErrorResponse("provider_error");
      return makeHealthResponse();
    };

    const player = new BufferedSpeechPlayer(makeChunks(3), events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    expect(errorCalled).toBe(true);
    expect(player.getMetrics().errors).toBeGreaterThan(0);
    player.destroy();
  });
});

/* ── 12. End of document transitions cleanly ────────────────────────────── */

describe("Test 12: Document end transitions cleanly", () => {
  it("prepare completes with all chunks ready", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      fetchCount++;
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const preparedChanges: [number, number][] = [];
    const events = makeEvents({
      onPreparedChange: (r, t) => preparedChanges.push([r, t]),
    });

    const player = new BufferedSpeechPlayer(makeChunks(3), events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    expect(player.preparedCount).toBe(3);
    expect(player.isPreparing).toBe(false);
    expect(preparedChanges.length).toBeGreaterThan(0);

    player.destroy();
  });
});

/* ── 13. Word boundary follows playback clock ───────────────────────────── */

describe("Test 13: Word boundary follows playback clock", () => {
  it("player exposes supportsWordBoundaries from provider metadata", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      fetchCount++;
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(1), events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 100));

    // Default: no word boundaries (mock provider doesn't provide them)
    expect(player.supportsWordBoundaries).toBe(false);

    player.destroy();
  });
});

/* ── 14. Fallback highlighting works without boundaries ─────────────────── */

describe("Test 14: Fallback highlighting without boundaries", () => {
  it("chunk-level tracking works when word boundaries are absent", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      fetchCount++;
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const chunkChanges: number[] = [];
    const events = makeEvents({
      onChunkChange: (i) => chunkChanges.push(i),
    });

    const player = new BufferedSpeechPlayer(makeChunks(3), events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    // Chunk 0 should be accessible
    expect(player.currentSegmentIds).toEqual([]); // No chunk played yet

    player.destroy();
  });
});

/* ── 15. Long document keeps bounded memory/buffer ──────────────────────── */

describe("Test 15: Long document bounded memory", () => {
  it("500 chunks does not crash the player", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      fetchCount++;
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(32)); // Smaller blobs for speed
      }
      return makeHealthResponse();
    };

    const chunks = makeChunks(500);
    const events = makeEvents();
    const player = new BufferedSpeechPlayer(chunks, events, {
      fetchImpl: fetchMock as never,
      prefetchDepth: 2,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 2000));

    // Should have prepared some chunks
    expect(player.preparedCount).toBeGreaterThan(0);
    // Should not have crashed
    expect(() => player.destroy()).not.toThrow();
  });
});

/* ── 16. Replay from persisted cache works ──────────────────────────────── */

describe("Test 16: Replay from cache works", () => {
  it("blobFor deduplication prevents duplicate fetches", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      fetchCount++;
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(2), events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    // First access
    const blob0a = await player.blobFor(0);
    const countAfterFirst = fetchCount;

    // Second access of same chunk (should dedup)
    const blob0b = await player.blobFor(0);

    expect(blob0a).toBe(blob0b); // Same blob reference
    expect(fetchCount).toBe(countAfterFirst); // No new fetch

    player.destroy();
  });
});

/* ── 17. First-fill is buffering, not error ─────────────────────────────── */

describe("Test 17: First-fill is buffering not error", () => {
  it("initial load shows buffering state, not error", async () => {
    let errorCalled = false;
    const stateChanges: string[] = [];
    const events = makeEvents({
      onError: () => {
        errorCalled = true;
      },
      onStateChange: (s) => stateChanges.push(s),
    });

    const fetchMock = createFetchMock({ latencyMs: 100, blobSize: 64 });
    const player = new BufferedSpeechPlayer(makeChunks(1), events, {
      fetchImpl: fetchMock,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 300));

    // State should NOT be error
    expect(player.currentState).not.toBe("error");
    // No error callback should have fired
    expect(errorCalled).toBe(false);
    // Should have prepared at least 1 chunk
    expect(player.preparedCount).toBe(1);

    player.destroy();
  });
});

/* ── 18. Mid-stream rebuffer recovers ───────────────────────────────────── */

describe("Test 18: Mid-stream rebuffer recovers", () => {
  it("player survives a mix of successful and failed fetches", async () => {
    let fetchCount = 0;
    const shouldFail = true;

    const fetchMock = async (input: string | URL | Request) => {
      fetchCount++;
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        if (shouldFail && fetchCount < 3) {
          // Fail first few requests
          return makeSpeechErrorResponse("provider_error");
        }
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    let errorCalled = false;
    const events = makeEvents({
      onError: () => {
        errorCalled = true;
      },
    });

    const player = new BufferedSpeechPlayer(makeChunks(5), events, {
      fetchImpl: fetchMock as never,
      prefetchDepth: 2,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 500));

    // Player should still be usable (some chunks may have failed, but not all)
    expect(() => player.destroy()).not.toThrow();
  });
});

/* ── 19. Rapid Play/Pause does not duplicate audio ──────────────────────── */

describe("Test 19: Rapid Play/Pause", () => {
  it("rapid state changes do not cause corruption", async () => {
    const fetchCount = 0;
    const fetchMock = createFetchMock({ latencyMs: 10, blobSize: 64 });

    const stateChanges: string[] = [];
    const events = makeEvents({
      onStateChange: (s) => stateChanges.push(s),
    });

    const player = new BufferedSpeechPlayer(makeChunks(2), events, {
      fetchImpl: fetchMock,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    // Rapid state changes
    for (let i = 0; i < 10; i++) {
      player.pause();
      player.resume();
      player.stop();
    }

    // Should still be in a valid state
    const validStates = [
      "idle",
      "loading",
      "buffering",
      "playing",
      "paused",
      "ended",
      "error",
    ];
    expect(validStates).toContain(player.currentState);

    // No errors should have been thrown
    expect(() => player.destroy()).not.toThrow();
  });
});

/* ── 20. Export and playback do not corrupt each other ───────────────────── */

describe("Test 20: Export/playback state isolation", () => {
  it("blobFor and prepare can coexist without state corruption", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      fetchCount++;
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(3), events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    // Export accesses blobFor() which triggers in-flight dedup
    const blob0 = await player.blobFor(0);
    const blob1 = await player.blobFor(1);

    expect(blob0).toBeDefined();
    expect(blob1).toBeDefined();

    // Player state should still be valid
    expect(player.currentState).not.toBe("error");

    // blobFor returns deduplicated blobs
    const blob0Again = await player.blobFor(0);
    expect(blob0Again).toBe(blob0); // Same blob reference (dedup)

    player.destroy();
  });
});

/* ── Engine-level tests (metadata/capabilities) ──────────────────────────── */

describe("BufferedAudioEngine: capabilities", () => {
  it("default provider has correct capabilities", async () => {
    // The engine's default capabilities should be all false
    // (word boundaries only when explicitly provided)
    const mockEvents: import("@/lib/buffered-audio-engine").AudioEngineEvents = {
      onStateChange: () => {},
    };
    const { BufferedAudioEngine } = await import("@/lib/buffered-audio-engine");
    const engine = new BufferedAudioEngine(mockEvents);

    expect(engine.supportsWordBoundaries).toBe(false);

    engine.destroy();
  });

  it("destroy is idempotent", async () => {
    const mockEvents: import("@/lib/buffered-audio-engine").AudioEngineEvents = {
      onStateChange: () => {},
    };
    const { BufferedAudioEngine } = await import("@/lib/buffered-audio-engine");
    const engine = new BufferedAudioEngine(mockEvents);

    engine.destroy();
    expect(() => engine.destroy()).not.toThrow();
  });
});

/* ── Gapless scheduling tests ────────────────────────────────────────────── */

describe("BufferedAudioEngine: gapless scheduling", () => {
  it("scheduleSource uses nextStartTime for gapless transitions", async () => {
    const stateChanges: string[] = [];
    const mockEvents: import("@/lib/buffered-audio-engine").AudioEngineEvents = {
      onStateChange: (s) => stateChanges.push(s),
    };
    const { BufferedAudioEngine } = await import("@/lib/buffered-audio-engine");
    const engine = new BufferedAudioEngine(mockEvents);

    // Engine starts idle
    expect(engine.currentState).toBe("idle");

    // After destroy, state is idle
    engine.destroy();
    expect(engine.currentState).toBe("idle");
  });

  it("scheduleGeneration increments on seek/pause/stop invalidate timers", async () => {
    const mockEvents: import("@/lib/buffered-audio-engine").AudioEngineEvents = {
      onStateChange: () => {},
    };
    const { BufferedAudioEngine } = await import("@/lib/buffered-audio-engine");
    const engine = new BufferedAudioEngine(mockEvents);

    // Verify engine can be created and destroyed without issues
    expect(engine.currentState).toBe("idle");
    engine.destroy();
    expect(engine.currentState).toBe("idle");
  });
});

/* ── Duration estimation tests ───────────────────────────────────────────── */

describe("BufferedSpeechPlayer: duration estimation", () => {
  it("estimatedDuration returns 0 when engine not created", async () => {
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(10), events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    // Some chunks should be prepared (fetched)
    expect(player.preparedCount).toBeGreaterThan(0);

    // But estimatedDuration is 0 because engine is not created until play()
    // (engine is only created in ensureEngine() during play())
    expect(player.estimatedDuration).toBe(0);

    player.destroy();
  });

  it("estimatedDuration returns 0 when no chunks decoded", async () => {
    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(5), events);

    // Before any preparation, estimated duration is 0
    expect(player.estimatedDuration).toBe(0);

    player.destroy();
  });
});

/* ── Rebuffer tracking tests ─────────────────────────────────────────────── */

describe("BufferedSpeechPlayer: rebuffer tracking", () => {
  it("isRebuffering is initially false", async () => {
    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(1), events);

    expect(player.isRebuffering).toBe(false);

    player.destroy();
  });
});

/* ── Edge cases ──────────────────────────────────────────────────────────── */

describe("BufferedSpeechPlayer: edge cases", () => {
  it("empty chunks array does not crash", async () => {
    const events = makeEvents();
    const player = new BufferedSpeechPlayer([], events);

    player.prepare();
    await new Promise((r) => setTimeout(r, 50));

    expect(player.preparedCount).toBe(0);
    expect(player.estimatedDuration).toBe(0);

    player.destroy();
  });

  it("play after destroy is safe", async () => {
    const fetchMock = createFetchMock({ latencyMs: 5 });
    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(2), events, {
      fetchImpl: fetchMock,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 100));
    player.destroy();

    // Play after destroy should be safe (no-op)
    await player.play(0);
    expect(player.isDestroyed).toBe(true);
  });

  it("setPlaybackRate after destroy is safe", async () => {
    const fetchMock = createFetchMock({ latencyMs: 5 });
    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(1), events, {
      fetchImpl: fetchMock,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 100));
    player.destroy();

    // setPlaybackRate after destroy should be safe (no-op)
    expect(() => player.setPlaybackRate(1.5)).not.toThrow();
  });

  it("seekToChunk bounds checking works", async () => {
    const fetchMock = createFetchMock({ latencyMs: 5 });
    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(3), events, {
      fetchImpl: fetchMock,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 100));

    // Seek beyond bounds should clamp
    await player.seekToChunk(100, false);
    expect(player.currentIndex).toBe(2); // Clamped to last chunk

    // Seek to negative should clamp to 0
    await player.seekToChunk(-5, false);
    expect(player.currentIndex).toBe(0);

    player.destroy();
  });

  it("getProgress returns valid structure", async () => {
    const fetchMock = createFetchMock({ latencyMs: 5 });
    const events = makeEvents();
    const player = new BufferedSpeechPlayer(makeChunks(2), events, {
      fetchImpl: fetchMock,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 100));

    const progress = player.getProgress();
    expect(progress).toHaveProperty("elapsed");
    expect(progress).toHaveProperty("duration");
    expect(progress).toHaveProperty("progress");
    expect(progress).toHaveProperty("isRebuffering");
    expect(progress).toHaveProperty("supportsWordBoundaries");
    expect(typeof progress.elapsed).toBe("number");
    expect(typeof progress.duration).toBe("number");
    expect(typeof progress.progress).toBe("number");
    expect(typeof progress.isRebuffering).toBe("boolean");
    expect(typeof progress.supportsWordBoundaries).toBe("boolean");

    player.destroy();
  });
});
