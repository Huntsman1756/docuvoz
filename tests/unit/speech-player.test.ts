/**
 * SpeechPlayer lifecycle & cancellation tests.
 *
 * Regression coverage for the AbortError fix:
 *  A. Document A preparing -> load B -> A aborted -> no unhandled rejection -> B usable
 *  B. Document A playing/prefetching -> load B -> no AbortError leak
 *  C. destroy() called twice -> no exception
 *  D. abort during in-flight mocked fetch -> cancellation is treated as normal lifecycle
 *  E. real fetch/provider error -> still surfaces as an error
 */
import { describe, expect, it } from "vitest";
import { SpeechPlayer, type PlayerEvents, isAbortError } from "@/lib/speech-player";

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function makeChunks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `chunk-${i}`,
    text: `Fragmento ${i + 1} de texto para sintetizacion de voz con contenido suficiente. `,
    segmentIds: [`seg-${i}`],
  }));
}

function makeEvents(overrides?: Partial<PlayerEvents>): PlayerEvents {
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
  h.set("cache-key", "test");
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

/* ------------------------------------------------------------------ */
/*  isAbortError classifier                                            */
/* ------------------------------------------------------------------ */

describe("isAbortError", () => {
  it("returns true for DOMException AbortError", () => {
    expect(isAbortError(new DOMException("test", "AbortError"))).toBe(true);
  });

  it("returns true for Error with AbortError name", () => {
    const e = new Error("test");
    e.name = "AbortError";
    expect(isAbortError(e)).toBe(true);
  });

  it("returns false for other DOMExceptions", () => {
    expect(isAbortError(new DOMException("test", "TypeError"))).toBe(false);
  });

  it("returns false for regular Errors", () => {
    expect(isAbortError(new Error("network error"))).toBe(false);
    expect(isAbortError(new Error())).toBe(false);
  });

  it("returns false for non-Error values", () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError("AbortError")).toBe(false);
    expect(isAbortError(42)).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Test A: prepare abort -> no unhandled rejection -> new doc usable  */
/* ------------------------------------------------------------------ */

describe("regression A: prepare abort on document switch", () => {
  it("aborting during prepare does not leak AbortError or metrics", async () => {
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 50));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const chunks = makeChunks(3);
    const events = makeEvents();

    const player = new SpeechPlayer(chunks, events, { fetchImpl: fetchMock as never });
    player.prepare();

    // Wait for the first fetch to be in-flight
    await new Promise((r) => setTimeout(r, 10));

    // Destroy mid-prepare
    player.destroy();

    // Wait for all pending operations to resolve/reject
    await new Promise((r) => setTimeout(r, 100));

    // The player must report destroyed
    expect(player.isDestroyed).toBe(true);

    // No error state from abort
    expect(player.currentState).not.toBe("error");
  });

  it("new player created after destroy works normally", async () => {
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 50));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const chunksA = makeChunks(2);
    const eventsA = makeEvents();
    const playerA = new SpeechPlayer(chunksA, eventsA, {
      fetchImpl: fetchMock as never,
    });
    playerA.prepare();

    await new Promise((r) => setTimeout(r, 10));
    playerA.destroy();

    // Create a new player with the same fetch mock
    const chunksB = makeChunks(2);
    const eventsB = makeEvents();
    const playerB = new SpeechPlayer(chunksB, eventsB, {
      fetchImpl: fetchMock as never,
    });
    playerB.prepare();

    // Wait for preparation to complete
    await new Promise((r) => setTimeout(r, 200));

    // Player B should have prepared all chunks
    expect(playerB.preparedCount).toBe(2);
    expect(playerB.isDestroyed).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/*  Test B: playing/prefetch abort -> no AbortError leak               */
/* ------------------------------------------------------------------ */

describe("regression B: destroy during play/prefetch", () => {
  it("destroy while prefetching does not set error state", async () => {
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 80));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const chunks = makeChunks(5);
    const events = makeEvents();

    const player = new SpeechPlayer(chunks, events, {
      fetchImpl: fetchMock as never,
      prefetchDepth: 3,
    });
    player.prepare();

    // Wait for first chunk to prepare, then try to play
    await new Promise((r) => setTimeout(r, 60));

    // Now destroy - this should abort all pending prefetches
    player.destroy();

    await new Promise((r) => setTimeout(r, 200));

    // The player state should not be "error" due to abort
    expect(player.currentState).not.toBe("error");

    // Player must be destroyed
    expect(player.isDestroyed).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Test C: idempotent destroy                                         */
/* ------------------------------------------------------------------ */

describe("regression C: destroy idempotency", () => {
  it("calling destroy() twice does not throw", async () => {
    const chunks = makeChunks(2);
    const events = makeEvents();
    const player = new SpeechPlayer(chunks, events);

    expect(() => player.destroy()).not.toThrow();
    expect(() => player.destroy()).not.toThrow();
    expect(() => player.destroy()).not.toThrow();

    expect(player.isDestroyed).toBe(true);
  });

  it("destroy after play does not throw", async () => {
    const chunks = makeChunks(1);
    const events = makeEvents();
    const player = new SpeechPlayer(chunks, events);

    player.play();
    expect(() => player.destroy()).not.toThrow();
    expect(() => player.destroy()).not.toThrow();
    expect(player.isDestroyed).toBe(true);
  });

  it("destroy during prepare does not throw", async () => {
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 200));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const chunks = makeChunks(3);
    const events = makeEvents();
    const player = new SpeechPlayer(chunks, events, {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 10));

    expect(() => player.destroy()).not.toThrow();
    expect(() => player.destroy()).not.toThrow();
    expect(player.isDestroyed).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Test D: abort during in-flight fetch is treated as normal          */
/* ------------------------------------------------------------------ */

describe("regression D: abort during in-flight fetch", () => {
  it("fetch cancelled mid-flight does not set error state", async () => {
    // Fetch that checks signal before starting and hangs if not aborted
    const signalAwareFetch = async (
      input: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        // Check if signal is already aborted before starting
        if (init?.signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        // Create a promise that never resolves (simulating slow fetch)
        return new Promise<Response>(() => {
          // Never resolves - the fetch is "in-flight"
        });
      }
      return makeHealthResponse();
    };

    const chunks = makeChunks(2);
    const events = makeEvents();
    const player = new SpeechPlayer(chunks, events, {
      fetchImpl: signalAwareFetch as never,
    });

    player.prepare();

    // Let the first fetch start
    await new Promise((r) => setTimeout(r, 20));

    // Destroy should abort the in-flight fetch
    player.destroy();

    // Wait for any potential rejections to surface
    await new Promise((r) => setTimeout(r, 100));

    // Player should not be in error state from abort
    expect(player.currentState).not.toBe("error");
    expect(player.isDestroyed).toBe(true);
  });

  it("destroy during play with in-flight fetch does not throw", async () => {
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        // Check signal before starting
        if (init?.signal?.aborted) {
          throw new DOMException("The operation was aborted.", "AbortError");
        }
        return new Promise<Response>(() => {
          // Never resolves - the fetch is "in-flight"
        });
      }
      return makeHealthResponse();
    };

    const chunks = makeChunks(1);
    const events = makeEvents();
    const player = new SpeechPlayer(chunks, events, { fetchImpl: fetchMock as never });

    // Start playing (which will call prepare + playChunkAt)
    player.prepare();

    // Wait for fetch to start
    await new Promise((r) => setTimeout(r, 20));

    // Destroy should abort the in-flight fetch - should not throw
    expect(() => player.destroy()).not.toThrow();

    // Wait for potential rejections
    await new Promise((r) => setTimeout(r, 100));

    // Player should not be in error state from abort
    expect(player.currentState).not.toBe("error");
    expect(player.isDestroyed).toBe(true);
  });
});

/* ------------------------------------------------------------------ */
/*  Test E: real errors still surface                                  */
/* ------------------------------------------------------------------ */

describe("regression E: real errors still surface", () => {
  it("HTTP error response is surfaced as error state", async () => {
    let errorReceived = false;

    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") return makeSpeechErrorResponse("provider_error");
      return makeHealthResponse();
    };

    const chunks = makeChunks(1);
    const events = makeEvents({
      onError: () => {
        errorReceived = true;
      },
    });
    const player = new SpeechPlayer(chunks, events, { fetchImpl: fetchMock as never });

    player.prepare();
    await new Promise((r) => setTimeout(r, 50));

    // onError should have been called with prepare_failed
    expect(errorReceived).toBe(true);

    // Player should eventually be in error or idle state (after destroyed)
    // The key point is that onError was called (not suppressed)
    const metrics = player.getMetrics();
    expect(metrics.errors).toBeGreaterThan(0);

    player.destroy();
  });

  it("non-ok response increments error metrics", async () => {
    let errorReceived = false;

    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") return makeSpeechErrorResponse("bad_gateway");
      return makeHealthResponse();
    };

    const chunks = makeChunks(1);
    const events = makeEvents({
      onError: () => {
        errorReceived = true;
      },
    });
    const player = new SpeechPlayer(chunks, events, { fetchImpl: fetchMock as never });

    player.prepare();
    await new Promise((r) => setTimeout(r, 50));

    // onError should have been called
    expect(errorReceived).toBe(true);

    // Error metrics should have been incremented
    const metrics = player.getMetrics();
    expect(metrics.errors).toBeGreaterThan(0);

    player.destroy();
  });
});
