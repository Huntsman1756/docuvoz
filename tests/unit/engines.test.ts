/**
 * Engine registry + Edge provider guards (server side, network-free).
 */
import { describe, expect, it } from "vitest";
import {
  escapeSsmlText,
  isValidEdgeVoice,
} from "@/adapters/speech-providers/edge-provider";
import { FileAudioCache } from "@/infrastructure/cache/file-audio-cache";
import { createLogger } from "@/infrastructure/logging/logger";
import {
  handleSpeech,
  resolveEngine,
  type HandlerDeps,
} from "@/server/api/speech-handler";
import { createEngines, loadConfig, type EngineRuntime } from "@/server/config";
import { SlidingWindowRateLimiter } from "@/server/rate-limit";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("edge voice validation", () => {
  it("accepts real neural voice short names", () => {
    expect(isValidEdgeVoice("es-ES-XimenaNeural")).toBe(true);
    expect(isValidEdgeVoice("en-US-GuyNeural")).toBe(true);
  });
  it("rejects anything that could break out of the SSML attribute", () => {
    expect(isValidEdgeVoice('X" ><speak>')).toBe(false);
    expect(isValidEdgeVoice("ef_dora")).toBe(false);
    expect(isValidEdgeVoice("es-ES-Whatever")).toBe(false);
    expect(isValidEdgeVoice("")).toBe(false);
  });
});

describe("escapeSsmlText", () => {
  it("neutralizes markup in untrusted document text", () => {
    // Quotes are safe inside text content; &, < and > are what could open tags.
    expect(escapeSsmlText('a < b && c > d <speak x="1"/>')).toBe(
      'a &lt; b &amp;&amp; c &gt; d &lt;speak x="1"/&gt;',
    );
  });
});

describe("createEngines", () => {
  it("exposes only the default engine unless Edge is enabled", () => {
    const base = loadConfig({ SPEECH_PROVIDER: "mock" });
    expect(createEngines(base).map((e) => e.id)).toEqual(["default"]);
    const withEdge = loadConfig({
      SPEECH_PROVIDER: "mock",
      EDGE_TTS_ENABLED: "1",
    });
    expect(createEngines(withEdge).map((e) => e.id)).toEqual(["default", "premium"]);
    // labels must be brand-free (product surface shows them)
    for (const e of createEngines(withEdge)) {
      expect(e.label).not.toMatch(/kokoro|nan|edge|ms/i);
    }
  });
  it("treats '0'/'false'/blank as disabled (coerce.boolean trap)", () => {
    for (const value of ["0", "false", ""]) {
      expect(
        loadConfig({ SPEECH_PROVIDER: "mock", EDGE_TTS_ENABLED: value }).EDGE_TTS_ENABLED,
      ).toBe(false);
    }
    expect(
      loadConfig({ SPEECH_PROVIDER: "mock", EDGE_TTS_ENABLED: "true" }).EDGE_TTS_ENABLED,
    ).toBe(true);
  });
});

function silentLogger() {
  const noop = () => undefined;
  const l: Record<string, unknown> = {
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
  };
  l.child = () => l;
  return l as unknown as ReturnType<typeof createLogger>;
}

function depsWith(engines: EngineRuntime[]): HandlerDeps {
  const config = loadConfig({ SPEECH_PROVIDER: "mock" });
  return {
    config,
    provider: engines[0].provider,
    engines,
    cache: new FileAudioCache(mkdtempSync(join(tmpdir(), "auidionan-engines-"))),
    limiter: new SlidingWindowRateLimiter(100),
    logger: silentLogger(),
  };
}

describe("engine resolution in the handler", () => {
  it("unknown engine ids fall back to the default without failing", async () => {
    const engines = createEngines(loadConfig({ SPEECH_PROVIDER: "mock" }));
    const res = await handleSpeech(
      { text: "hola", engine: "no-existe" },
      "c",
      depsWith(engines),
    );
    expect(res.status).toBe(200);
    expect(resolveEngine(depsWith(engines), "no-existe").fellBack).toBe(true);
  });

  it("a different engine produces a different cache key for the same text", async () => {
    const engines = createEngines(loadConfig({ SPEECH_PROVIDER: "mock" }));
    const premium: EngineRuntime = {
      ...engines[0],
      id: "premium",
      provider: {
        name: "othermock",
        synthesize: (req) => engines[0].provider.synthesize(req),
      },
      model: "other-1",
    };
    const d = depsWith([...engines, premium]);
    const a = await handleSpeech({ text: "mismo texto" }, "c", d);
    const b = await handleSpeech({ text: "mismo texto", engine: "premium" }, "c", d);
    expect(a.headers["cache-key"]).not.toBe(b.headers["cache-key"]);
  });

  it("rejects malformed edge voice names by falling back to the engine default", async () => {
    const engines = createEngines(loadConfig({ SPEECH_PROVIDER: "mock" }));
    const edgeRuntime: EngineRuntime = {
      ...engines[0],
      id: "premium",
      provider: {
        name: "edge",
        synthesize: async (req) => ({
          audio: new Uint8Array([req.settings.voice === "es-ES-XimenaNeural" ? 1 : 0]),
          mimeType: "audio/mpeg",
        }),
      },
      defaultVoice: "es-ES-XimenaNeural",
    };
    const d = depsWith([...engines, edgeRuntime]);
    const evil = await handleSpeech(
      { text: "x", engine: "premium", voice: 'a" evil><speak>' },
      "c",
      d,
    );
    expect(evil.status).toBe(200);
    // the synthesized request received the sanitized default voice
    expect(evil.audio?.[0]).toBe(1);
  });
});
