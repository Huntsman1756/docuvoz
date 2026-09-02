import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { MockSpeechProvider } from "@/adapters/speech-providers/mock-provider";
import { FileAudioCache } from "@/infrastructure/cache/file-audio-cache";
import { createLogger } from "@/infrastructure/logging/logger";
import { handleSpeech, type HandlerDeps } from "@/server/api/speech-handler";
import { ConfigError, loadConfig } from "@/server/config";
import { SlidingWindowRateLimiter } from "@/server/rate-limit";

const cacheDir = mkdtempSync(join(tmpdir(), "auidionan-cache-"));
afterAll(() => rmSync(cacheDir, { recursive: true, force: true }));

function deps(
  overrides: {
    provider?: HandlerDeps["provider"];
    limitPerMinute?: number;
    maxTextChars?: number;
  } = {},
): { deps: HandlerDeps; logs: Record<string, unknown>[] } {
  const config = loadConfig({ SPEECH_PROVIDER: "mock", NODE_ENV: "test" });
  const logs: Record<string, unknown>[] = [];
  const capturingLogger = {
    debug: (f: object) => logs.push({ level: "debug", ...f }),
    info: (f: object) => logs.push({ level: "info", ...f }),
    warn: (f: object) => logs.push({ level: "warn", ...f }),
    error: (f: object) => logs.push({ level: "error", ...f }),
    child: () => capturingLogger,
  };
  return {
    deps: {
      config: {
        ...config,
        SPEECH_MAX_TEXT_CHARS: overrides.maxTextChars ?? config.SPEECH_MAX_TEXT_CHARS,
      },
      provider: overrides.provider ?? new MockSpeechProvider(),
      cache: new FileAudioCache(mkdtempSync(join(tmpdir(), "auidionan-test-"))),
      limiter: new SlidingWindowRateLimiter(overrides.limitPerMinute ?? 100),
      logger: (capturingLogger as never) ?? createLogger(),
    },
    logs,
  };
}

describe("loadConfig", () => {
  it("accepts the mock provider without credentials", () => {
    expect(() => loadConfig({ SPEECH_PROVIDER: "mock" })).not.toThrow();
  });
  it("requires base URL and key for the nan provider", () => {
    expect(() => loadConfig({ SPEECH_PROVIDER: "nan" })).toThrow(ConfigError);
    try {
      loadConfig({ SPEECH_PROVIDER: "nan" });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("NAN_BASE_URL");
      expect(message).toContain("NAN_API_KEY");
      expect(message).not.toContain("undefined");
    }
  });
  it("rejects garbage values", () => {
    expect(() =>
      loadConfig({ SPEECH_PROVIDER: "mock", SPEECH_MAX_CONCURRENCY: "99" }),
    ).toThrow(ConfigError);
  });
});

describe("handleSpeech", () => {
  it("serves audio and caches it (MISS then HIT)", async () => {
    const { deps: d } = deps();
    const first = await handleSpeech({ text: "Hola, mundo." }, "client-a", d);
    expect(first.status).toBe(200);
    expect(first.headers["content-type"]).toBe("audio/wav");
    expect(first.headers["cache-status"]).toBe("MISS");
    expect(first.audio?.byteLength).toBeGreaterThan(44);
    const second = await handleSpeech({ text: "Hola, mundo." }, "client-a", d);
    expect(second.headers["cache-status"]).toBe("HIT");
  });

  it("never returns the same key for different settings", async () => {
    const { deps: d } = deps();
    const a = await handleSpeech({ text: "Mismo texto.", speed: 1 }, "c", d);
    const b = await handleSpeech({ text: "Mismo texto.", speed: 1.5 }, "c", d);
    expect(a.headers["cache-key"]).not.toBe(b.headers["cache-key"]);
  });

  it("rejects invalid bodies with a stable code", async () => {
    const { deps: d } = deps();
    const res = await handleSpeech({ text: "" }, "c", d);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "invalid_request" });
    const nope = await handleSpeech({ nobody: "expects" }, "c", d);
    expect(nope.status).toBe(400);
    const tooLong = await handleSpeech({ text: "x".repeat(9999) }, "c", d);
    expect(tooLong.status).toBe(413); // within schema, above synthesis text cap
  });

  it("rejects over-long text with 413", async () => {
    const { deps: d } = deps({ maxTextChars: 100 });
    const res = await handleSpeech({ text: "a".repeat(150) }, "c", d);
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: "too_large" });
  });

  it("rate-limits per client with a retry hint", async () => {
    const { deps: d } = deps({ limitPerMinute: 2 });
    expect((await handleSpeech({ text: "uno" }, "slow", d)).status).toBe(200);
    expect((await handleSpeech({ text: "dos" }, "slow", d)).status).toBe(200);
    const third = await handleSpeech({ text: "tres" }, "slow", d);
    expect(third.status).toBe(429);
    expect(third.headers["retry-after"]).toBeTruthy();
    // different client is unaffected
    expect((await handleSpeech({ text: "uno" }, "fast", d)).status).toBe(200);
  });

  it("classifies client cancellation as cancelled, not as a provider error", async () => {
    const { deps: d, logs } = deps({
      provider: new MockSpeechProvider({ latencyMs: 50 }),
    });
    const controller = new AbortController();
    const promise = handleSpeech({ text: "cancel me" }, "c", d, controller.signal);
    controller.abort();
    const res = await promise;
    expect(res.status).toBe(499);
    expect(res.body).toEqual({ error: "cancelled" });
    expect(logs.some((l) => l.outcome === "cancelled")).toBe(true);
    expect(logs.some((l) => l.outcome === "error")).toBe(false);
  });

  it("maps provider errors to stable codes without internals", async () => {
    const failing = new MockSpeechProvider({ failEvery: 1 });
    const { deps: d, logs } = deps({ provider: failing });
    const res = await handleSpeech({ text: "falla" }, "c", d);
    expect(res.status).toBe(502);
    expect(res.body).toEqual({ error: "provider_error" });
    const errorLog = logs.find((l) => l.level === "error");
    expect(errorLog).toBeDefined();
    // document content is logged as a fingerprint, never in the clear
    expect(JSON.stringify(errorLog)).not.toContain("falla");
  });

  it("logs no raw document text on success either", async () => {
    const { deps: d, logs } = deps();
    await handleSpeech({ text: "contenido confidencial" }, "c", d);
    const dump = JSON.stringify(logs);
    expect(dump).not.toContain("contenido confidencial");
    expect(dump).toContain("content"); // fingerprint field present
  });
});
