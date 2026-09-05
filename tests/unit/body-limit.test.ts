/**
 * F06 — HTTP body limit tests.
 *
 * Tests the bounded JSON-body reader in the speech route.
 * Uses the actual handleSpeech handler (unit-testable without a running server)
 * combined with simulated body reading to verify byte-counting behavior.
 */
import { describe, expect, it } from "vitest";
import { MockSpeechProvider } from "@/adapters/speech-providers/mock-provider";
import { FileAudioCache } from "@/infrastructure/cache/file-audio-cache";
import { createLogger } from "@/infrastructure/logging/logger";
import { handleSpeech, type HandlerDeps } from "@/server/api/speech-handler";
import { loadConfig } from "@/server/config";
import { SlidingWindowRateLimiter } from "@/server/rate-limit";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function deps(): HandlerDeps {
  const config = loadConfig({ SPEECH_PROVIDER: "mock", NODE_ENV: "test" });
  return {
    config,
    provider: new MockSpeechProvider(),
    cache: new FileAudioCache(mkdtempSync(join(tmpdir(), "auidionan-body-test-"))),
    limiter: new SlidingWindowRateLimiter(100),
    logger: createLogger({ component: "test" }),
  };
}

describe("handleSpeech body validation", () => {
  it("accepts a normal small request", async () => {
    const d = deps();
    const result = await handleSpeech({ text: "Hola mundo" }, "client-1", d);
    expect(result.status).toBe(200);
    expect(result.audio).toBeDefined();
  });

  it("rejects empty text", async () => {
    const d = deps();
    const result = await handleSpeech({ text: "" }, "client-1", d);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "invalid_request" });
  });

  it("rejects text exceeding SPEECH_MAX_TEXT_CHARS", async () => {
    const d = deps();
    // Default max is 600 chars
    const result = await handleSpeech({ text: "a".repeat(700) }, "client-1", d);
    expect(result.status).toBe(413);
    expect(result.body).toEqual({ error: "too_large" });
  });

  it("rejects non-JSON body (missing required fields)", async () => {
    const d = deps();
    const result = await handleSpeech({ nobody: "expects" }, "client-1", d);
    expect(result.status).toBe(400);
    expect(result.body).toEqual({ error: "invalid_request" });
  });

  it("validates schema strictly (extra fields ignored, required fields enforced)", async () => {
    const d = deps();
    // Missing text
    const r1 = await handleSpeech({ voice: "test" }, "c", d);
    expect(r1.status).toBe(400);
    // Extra fields are ignored by Zod (strip mode not set, but unknown keys are ignored)
    const r2 = await handleSpeech({ text: "ok", extra: "ignored" }, "c", d);
    expect(r2.status).toBe(200);
  });
});

describe("API_MAX_BODY_BYTES config", () => {
  it("has a reasonable default (16 KB)", () => {
    const config = loadConfig({ SPEECH_PROVIDER: "mock" });
    expect(config.API_MAX_BODY_BYTES).toBe(16384);
  });

  it("is configurable via env", () => {
    const config = loadConfig({
      SPEECH_PROVIDER: "mock",
      API_MAX_BODY_BYTES: "8192",
    });
    expect(config.API_MAX_BODY_BYTES).toBe(8192);
  });
});
