/**
 * Edge TTS provider capability tests.
 *
 * Verifies that:
 *  - Engine registry exposes Edge capabilities via /api/health
 *  - BufferedSpeechPlayer exposes preferredForSpanish for Edge
 *  - supportsWordBoundaries is true when Edge is the active engine
 *  - Default engine does not have preferredForSpanish
 *  - Provider metadata flows from health descriptor to the player
 */
import { describe, expect, it } from "vitest";
import { BufferedSpeechPlayer } from "@/lib/buffered-player";
import type { BufferedPlayerEvents, PlaybackProgress } from "@/lib/buffered-player";

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

function makeSpeechResponse(blob: Blob): Response {
  const h = new Headers();
  h.set("cache-key", `test-key-${blob.size}`);
  h.set("x-provider", "edge");
  return {
    ok: true,
    status: 200,
    json: async () => makeHealthResponse(),
    blob: async () => blob,
    headers: h,
  } as Response;
}

function makeBlob(size = 64): Blob {
  return new Blob([new Uint8Array(size)], { type: "audio/wav" });
}

function makeHealthResponse() {
  return {
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
      {
        id: "edge",
        label: "Edge TTS",
        provider: "edge",
        model: "edge-model",
        format: "mp3",
      },
    ],
  };
}

/* ── Edge TTS: preferredForSpanish ──────────────────────────────────────── */

describe("Edge TTS: preferredForSpanish capability", () => {
  it("player exposes preferredForSpanish when engine is Edge", async () => {
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const player = new BufferedSpeechPlayer(makeChunks(1), makeEvents(), {
      fetchImpl: fetchMock as never,
      engine: "edge",
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    expect(player.providerMetadata).not.toBeNull();
    const meta = player.providerMetadata as NonNullable<typeof player.providerMetadata>;
    expect(meta.capabilities.preferredForSpanish).toBe(true);

    player.destroy();
  });

  it("default engine does not have preferredForSpanish", async () => {
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        // Default mock provider does not set x-provider header as "edge"
        const h = new Headers();
        h.set("cache-key", "test");
        return {
          ok: true,
          status: 200,
          json: async () => makeHealthResponse(),
          blob: async () => makeBlob(64),
          headers: h,
        } as Response;
      }
      return makeHealthResponse();
    };

    const player = new BufferedSpeechPlayer(makeChunks(1), makeEvents(), {
      fetchImpl: fetchMock as never,
      engine: "default",
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    const meta = player.providerMetadata;
    if (meta) {
      // Default engine should NOT have preferredForSpanish flagged
      expect(meta.capabilities.preferredForSpanish).not.toBe(true);
    }

    player.destroy();
  });
});

/* ── Edge TTS: supportsWordBoundaries ───────────────────────────────────── */

describe("Edge TTS: supportsWordBoundaries", () => {
  it("player reports word boundaries when engine is Edge", async () => {
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const player = new BufferedSpeechPlayer(makeChunks(1), makeEvents(), {
      fetchImpl: fetchMock as never,
      engine: "edge",
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    expect(player.supportsWordBoundaries).toBe(true);

    player.destroy();
  });

  it("supportsWordBoundaries is pre-resolved from health endpoint", async () => {
    // The provider metadata should be available before the first speech
    // fetch completes, from the health endpoint resolution in ensureEngine.
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") {
        return makeHealthResponse();
      }
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 50));
        return makeSpeechResponse(makeBlob(64));
      }
      return makeHealthResponse();
    };

    const player = new BufferedSpeechPlayer(makeChunks(2), makeEvents(), {
      fetchImpl: fetchMock as never,
      engine: "edge",
    });

    // Play triggers ensureEngine which resolves provider metadata from health.
    await player.play(0);

    // Word boundaries should be true even before speech fetch completes
    // (because the engine pre-resolves from health descriptor).
    expect(player.supportsWordBoundaries).toBe(true);

    player.destroy();
  });
});

/* ── Provider metadata flow ─────────────────────────────────────────────── */

describe("Provider metadata flow", () => {
  it("providerMetadata is null initially", async () => {
    const player = new BufferedSpeechPlayer(makeChunks(1), makeEvents());
    expect(player.providerMetadata).toBeNull();
    player.destroy();
  });

  it("providerMetadata updates after first fetch with x-provider header", async () => {
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        // Set x-provider header for Edge TTS
        const h = new Headers();
        h.set("cache-key", "test");
        h.set("x-provider", "edge");
        return {
          ok: true,
          status: 200,
          json: async () => makeHealthResponse(),
          blob: async () => makeBlob(64),
          headers: h,
        } as Response;
      }
      return makeHealthResponse();
    };

    const player = new BufferedSpeechPlayer(makeChunks(1), makeEvents(), {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    // After prepare completes, provider metadata should be set
    const meta = player.providerMetadata;
    expect(meta).not.toBeNull();
    expect((meta as NonNullable<typeof meta>).name).toBe("edge");

    player.destroy();
  });

  it("progress reports word boundary support from provider metadata", async () => {
    const fetchMock = async (input: string | URL | Request) => {
      const url = input.toString();
      if (url === "/api/health") return makeHealthResponse();
      if (url === "/api/speech") {
        await new Promise((r) => setTimeout(r, 5));
        const h = new Headers();
        h.set("cache-key", "test");
        h.set("x-provider", "edge");
        return {
          ok: true,
          status: 200,
          json: async () => makeHealthResponse(),
          blob: async () => makeBlob(64),
          headers: h,
        } as Response;
      }
      return makeHealthResponse();
    };

    const player = new BufferedSpeechPlayer(makeChunks(1), makeEvents(), {
      fetchImpl: fetchMock as never,
    });

    player.prepare();
    await new Promise((r) => setTimeout(r, 200));

    const progress: PlaybackProgress = player.getProgress();
    expect(progress.supportsWordBoundaries).toBe(true);

    player.destroy();
  });
});

/* ── Edge provider getMetadata ──────────────────────────────────────────── */

describe("EdgeSpeechProvider metadata", () => {
  it("Edge provider module is importable", async () => {
    const { EdgeSpeechProvider } =
      await import("@/adapters/speech-providers/edge-provider");
    // Edge provider must be importable; metadata check is at module level.
    // The provider is only usable when Edge TTS is enabled on the server,
    // so we just verify the import works.
    expect(typeof EdgeSpeechProvider).toBe("function");
  });
});

/* ── Voices: resolveEngine ──────────────────────────────────────────────── */

describe("voices: resolveEngine language-aware routing", () => {
  it("Spanish text resolves to Edge when available", async () => {
    const { resolveEngine, detectLanguage } = await import("@/lib/voices");
    const lang = detectLanguage("Este es un documento en espaol para probar la deteccin");
    expect(lang).toBe("es");
    const engine = resolveEngine("auto", lang, ["edge", "default"]);
    expect(engine).toBe("edge");
  });

  it("English text stays on default engine", async () => {
    const { resolveEngine, detectLanguage } = await import("@/lib/voices");
    const lang = detectLanguage("This is an english document to test language detection");
    expect(lang).toBe("en");
    const engine = resolveEngine("auto", lang, ["edge", "default"]);
    expect(engine).toBe("default");
  });

  it("explicit engine override is respected", async () => {
    const { resolveEngine } = await import("@/lib/voices");
    const engine = resolveEngine("default", "es", ["edge", "default"]);
    expect(engine).toBe("default");
  });

  it("unavailable engine falls back to default", async () => {
    const { resolveEngine } = await import("@/lib/voices");
    const engine = resolveEngine("edge", "es", ["default"]);
    expect(engine).toBe("default");
  });
});
