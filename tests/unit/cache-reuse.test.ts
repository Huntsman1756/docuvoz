/** Production blobFor fetch/cache tests and standalone acquireSynthesis tests.
 * Repeated blob access models consumers, but does not invoke export encoders.
 * Player controls plus blob reuse are covered in audio-timeline.test.ts.
 */
import { describe, expect, it } from "vitest";
import { BufferedSpeechPlayer, acquireSynthesis } from "@/lib/buffered-player";

/* ── Helpers ─────────────────────────────────────────────────────────────── */

function makeChunks(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: `chunk-${i}`,
    text: `Texto del fragmento ${i + 1} para prueba de cache. `,
    segmentIds: [`seg-${i}`],
  }));
}

function makeEvents() {
  return {
    onStateChange: () => {},
    onChunkChange: () => {},
    onMetrics: () => {},
    onError: () => {},
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
  h.set("cache-key", `key-${blob.size}`);
  return {
    ok: true,
    status: 200,
    json: makeHealthResponse().json,
    blob: async () => blob,
    headers: h,
  } as Response;
}

function makeBlob(size = 64): Blob {
  return new Blob([new Uint8Array(size)], { type: "audio/wav" });
}

/* ── Cache reuse: play → export → export ─────────────────────────────────── */

describe("Cache reuse across repeated blobFor access", () => {
  it("blobFor returns the same blob from cache on repeated calls", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        fetchCount++;
        return makeSpeechResponse(makeBlob(128));
      }
      return makeHealthResponse();
    };

    const events = makeEvents();
    const chunks = makeChunks(3);
    const player = new BufferedSpeechPlayer(chunks, events, {
      fetchImpl: fetchMock as never,
    });

    // Simulate "play" by calling blobFor for each chunk
    const playBlobs = await Promise.all(chunks.map((_, i) => player.blobFor(i)));
    const fetchesAfterPlay = fetchCount;

    // Simulate "export WAV" — should use cached blobs
    const wavBlobs = await Promise.all(chunks.map((_, i) => player.blobFor(i)));
    expect(fetchCount).toBe(fetchesAfterPlay); // no new fetches

    // Simulate "export MP3" — same blobs, still cached
    const mp3Blobs = await Promise.all(chunks.map((_, i) => player.blobFor(i)));
    expect(fetchCount).toBe(fetchesAfterPlay); // no new fetches

    // Simulate "export M4A" — same blobs
    await Promise.all(chunks.map((_, i) => player.blobFor(i)));
    expect(fetchCount).toBe(fetchesAfterPlay);

    // Simulate "export MP3 again" — same blobs
    await Promise.all(chunks.map((_, i) => player.blobFor(i)));
    expect(fetchCount).toBe(fetchesAfterPlay);

    // Verify all returned blobs are the same instance
    for (let i = 0; i < chunks.length; i++) {
      expect(wavBlobs[i]).toBe(playBlobs[i]);
      expect(mp3Blobs[i]).toBe(playBlobs[i]);
    }

    player.destroy();
  });

  it("each chunk text triggers exactly one synthesis request", async () => {
    const requestsByChunk = new Map<string, number>();
    const fetchMock = async (input: string | URL | Request, init?: RequestInit) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        let text = "";
        try {
          text = String(JSON.parse((init?.body as string) ?? "")?.text);
        } catch {
          /* */
        }
        requestsByChunk.set(text, (requestsByChunk.get(text) ?? 0) + 1);
        return makeSpeechResponse(makeBlob(128));
      }
      return makeHealthResponse();
    };

    const events = makeEvents();
    const chunks = makeChunks(4);
    const player = new BufferedSpeechPlayer(chunks, events, {
      fetchImpl: fetchMock as never,
    });

    // Play
    await Promise.all(chunks.map((_, i) => player.blobFor(i)));

    // Export × 3
    for (let round = 0; round < 3; round++) {
      await Promise.all(chunks.map((_, i) => player.blobFor(i)));
    }

    // Each chunk text should have exactly 1 request
    for (const [, count] of requestsByChunk) {
      expect(count).toBe(1);
    }

    player.destroy();
  });
});

/* ── Concurrent dedup: playback + export requesting same chunk ──────────── */

describe("acquireSynthesis helper in-flight dedup", () => {
  it("two simultaneous requests for the same cache key produce one fetch", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        fetchCount++;
        await new Promise((r) => setTimeout(r, 20));
        return makeSpeechResponse(makeBlob(128));
      }
      return makeHealthResponse();
    };

    // Use acquireSynthesis directly to test dedup
    const key = "test-cache-key-abc";
    const fetchFn = async (): Promise<Blob> => {
      const res = await fetchMock("/api/speech");
      return res.blob();
    };

    // Launch two concurrent acquisitions for the same key
    const [a, b] = await Promise.all([
      acquireSynthesis(key, fetchFn),
      acquireSynthesis(key, fetchFn),
    ]);

    expect(a).toBe(b); // same promise resolved
    expect(fetchCount).toBe(1); // only one network request
  });

  it("sequential requests after completion also produce one fetch each", async () => {
    let fetchCount = 0;
    const fetchFn = async () => {
      fetchCount++;
      return new Blob([new Uint8Array(64)]);
    };

    const key = "test-sequential-key";
    await acquireSynthesis(key, fetchFn);
    await acquireSynthesis(key, fetchFn);

    // Two sequential requests after the first completed = 2 fetches
    // (no in-flight dedup after resolution)
    expect(fetchCount).toBe(2);
  });
});

/* ── Export format does not affect cache identity ────────────────────────── */

describe("Blob cache independence from playback rate", () => {
  it("changing playback rate does not invalidate the cache", async () => {
    let fetchCount = 0;
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        fetchCount++;
        return makeSpeechResponse(makeBlob(128));
      }
      return makeHealthResponse();
    };

    const events = makeEvents();
    const chunks = makeChunks(2);
    const player = new BufferedSpeechPlayer(chunks, events, {
      fetchImpl: fetchMock as never,
    });

    // Fetch at default rate
    await player.blobFor(0);
    const afterDefault = fetchCount;

    // Change rate and fetch again — same blob, no new fetch
    player.setPlaybackRate(1.5);
    await player.blobFor(0);
    expect(fetchCount).toBe(afterDefault);

    // Change rate again
    player.setPlaybackRate(2.0);
    await player.blobFor(0);
    expect(fetchCount).toBe(afterDefault);

    player.destroy();
  });
});
