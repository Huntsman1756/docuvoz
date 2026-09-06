import { describe, it, expect, vi } from "vitest";
import { WebSpeechTransport } from "@/lib/web-speech-transport";
import { DesktopSpeechTransport, parseFrame } from "@/lib/desktop-speech-transport";
import { isDesktopRuntime } from "@/lib/speech-transport";

/* ── WebSpeechTransport ─────────────────────────────────────────────────── */

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

function makeSpeechResponse(overrides?: {
  cacheStatus?: string;
  boundaries?: unknown;
  provider?: string;
  contentType?: string;
}): Response {
  const h = new Headers();
  h.set("cache-key", "server-key-1");
  h.set("cache-status", overrides?.cacheStatus ?? "MISS");
  h.set("content-type", overrides?.contentType ?? "audio/wav");
  if (overrides?.boundaries)
    h.set("x-word-boundaries", btoa(JSON.stringify(overrides.boundaries)));
  if (overrides?.provider) h.set("x-provider", overrides.provider);
  return {
    ok: true,
    status: 200,
    blob: async () => new Blob([new Uint8Array(8)], { type: "audio/wav" }),
    json: makeHealthResponse().json,
    headers: h,
  } as Response;
}

describe("WebSpeechTransport", () => {
  it("health returns the descriptor", async () => {
    const transport = new WebSpeechTransport((async () => makeHealthResponse()) as never);
    const h = await transport.health();
    expect(h.provider).toBe("mock");
  });

  it("synthesize maps response metadata into the result", async () => {
    const transport = new WebSpeechTransport((async () =>
      makeSpeechResponse({
        cacheStatus: "HIT",
        boundaries: [{ text: "hola", offsetSeconds: 0.5, durationSeconds: 0.3 }],
        provider: "edge",
      })) as never);
    const result = await transport.synthesize({ text: "hola" });
    expect(result.cacheKey).toBe("server-key-1");
    expect(result.cacheStatus).toBe("HIT");
    expect(result.mimeType).toBe("audio/wav");
    expect(result.providerName).toBe("edge");
    expect(result.boundaries).toHaveLength(1);
    expect(result.audio.type).toBe("audio/wav");
  });

  it("synthesize throws the stable error code on non-ok response", async () => {
    const transport = new WebSpeechTransport((async () => ({
      ok: false,
      status: 500,
      json: async () => ({ error: "provider_unavailable" }),
      headers: new Headers(),
    })) as never);
    await expect(transport.synthesize({ text: "x" })).rejects.toThrow(
      "provider_unavailable",
    );
  });

  it("synthesize passes the AbortSignal through to fetch", async () => {
    let seenSignal: AbortSignal | null | undefined;
    const transport = new WebSpeechTransport((async (
      _url: RequestInfo | URL,
      init?: RequestInit,
    ) => {
      seenSignal = init?.signal;
      return makeSpeechResponse();
    }) as never);
    const controller = new AbortController();
    await transport.synthesize({ text: "x" }, controller.signal);
    expect(seenSignal).toBe(controller.signal);
  });
});

/* ── Binary frame ───────────────────────────────────────────────────────── */

function encodeFrame(metadata: unknown, audio: Uint8Array): ArrayBuffer {
  const metaBytes = new TextEncoder().encode(JSON.stringify(metadata));
  const frame = new Uint8Array(4 + metaBytes.length + audio.length);
  new DataView(frame.buffer).setUint32(0, metaBytes.length, true);
  frame.set(metaBytes, 4);
  frame.set(audio, 4 + metaBytes.length);
  return frame.buffer;
}

describe("parseFrame", () => {
  it("parses a valid frame into a SpeechSynthesisResult", () => {
    const audio = new Uint8Array([1, 2, 3, 4]);
    const frame = encodeFrame(
      {
        mimeType: "audio/mpeg",
        cacheKey: "k",
        cacheStatus: "MISS",
        providerDurationMs: 1200,
        boundaries: [{ text: "a", offsetSeconds: 0, durationSeconds: 1 }],
        providerName: "edge",
      },
      audio,
    );
    const result = parseFrame(frame);
    expect(result.mimeType).toBe("audio/mpeg");
    expect(result.cacheKey).toBe("k");
    expect(result.cacheStatus).toBe("MISS");
    expect(result.providerDurationMs).toBe(1200);
    expect(result.providerName).toBe("edge");
    expect(result.audio.size).toBe(4);
  });

  it("rejects a truncated frame", () => {
    expect(() => parseFrame(new ArrayBuffer(2))).toThrow("malformed_frame");
    const meta = new TextEncoder().encode(
      JSON.stringify({ mimeType: "a/wav", cacheKey: "k", cacheStatus: "MISS" }),
    );
    const frame = new Uint8Array(4 + meta.length + 4);
    new DataView(frame.buffer).setUint32(0, meta.length + 100, true); // metadataLength lies past the buffer
    frame.set(meta, 4);
    expect(() => parseFrame(frame.buffer)).toThrow("truncated_frame");
  });

  it("rejects malformed metadata JSON", () => {
    const meta = new TextEncoder().encode("{ not valid json ");
    const frame = new Uint8Array(4 + meta.length);
    new DataView(frame.buffer).setUint32(0, meta.length, true);
    frame.set(meta, 4);
    expect(() => parseFrame(frame.buffer)).toThrow("malformed_frame_metadata");
  });

  it("rejects a frame whose metadata advertises an error", () => {
    const frame = encodeFrame({ error: "provider_timeout" }, new Uint8Array(0));
    expect(() => parseFrame(frame)).toThrow("provider_timeout");
  });

  it("rejects an oversized metadata header", () => {
    const frame = new Uint8Array(4 + 4);
    new DataView(frame.buffer).setUint32(0, 10 * 1024 * 1024, true);
    expect(() => parseFrame(frame.buffer)).toThrow("malformed_frame_metadata");
  });
});

/* ── DesktopSpeechTransport ─────────────────────────────────────────────── */

describe("DesktopSpeechTransport", () => {
  it("isDesktopRuntime is false outside a Tauri WebView", () => {
    expect(isDesktopRuntime()).toBe(false);
  });

  it("synthesize invokes speech and parses the frame", async () => {
    const audio = new Uint8Array([9, 9]);
    const frame = encodeFrame(
      { mimeType: "audio/wav", cacheKey: "k", cacheStatus: "MISS" },
      audio,
    );
    const invoke = vi.fn(async (cmd: string, args?: Record<string, unknown>) => {
      if (cmd === "speech_health") {
        return { provider: "mock", model: "m", voice: "v", speed: 1, format: "wav" };
      }
      if (cmd === "speech") {
        expect(args).toMatchObject({ text: "hola", requestId: expect.any(String) });
        return frame;
      }
      return undefined;
    });

    (globalThis as { window?: unknown }).window = {
      __TAURI__: { core: { invoke } },
      __TAURI_INTERNALS__: {},
    };
    try {
      const transport = new DesktopSpeechTransport();
      const result = await transport.synthesize({ text: "hola" });
      expect(result.cacheKey).toBe("k");
      expect(result.audio.size).toBe(2);
      expect(invoke).toHaveBeenCalledWith(
        "speech",
        expect.objectContaining({ text: "hola" }),
      );
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("cancels the sidecar request when the caller signal aborts", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "speech") {
        return new Promise((_resolve, reject) => {
          // Never resolves; the abort listener triggers speech_cancel.
          setTimeout(() => reject(new DOMException("aborted", "AbortError")), 50);
        });
      }
      if (cmd === "speech_cancel") return undefined;
      return undefined;
    });
    (globalThis as { window?: unknown }).window = {
      __TAURI__: { core: { invoke } },
      __TAURI_INTERNALS__: {},
    };
    try {
      const transport = new DesktopSpeechTransport();
      const controller = new AbortController();
      const p = transport.synthesize({ text: "hola" }, controller.signal);
      controller.abort();
      await expect(p).rejects.toThrow();
      expect(invoke).toHaveBeenCalledWith("speech_cancel", {
        requestId: expect.any(String),
      });
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });

  it("health invokes speech_health", async () => {
    const invoke = vi.fn(async (cmd: string) => {
      if (cmd === "speech_health")
        return { provider: "mock", model: "m", voice: "v", speed: 1, format: "wav" };
      return undefined;
    });
    (globalThis as { window?: unknown }).window = {
      __TAURI__: { core: { invoke } },
      __TAURI_INTERNALS__: {},
    };
    try {
      const transport = new DesktopSpeechTransport();
      const h = await transport.health();
      expect(h.provider).toBe("mock");
    } finally {
      delete (globalThis as { window?: unknown }).window;
    }
  });
});
