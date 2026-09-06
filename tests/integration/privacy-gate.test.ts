/**
 * Privacy gate — nothing before Play (desktop contract, §8).
 *
 * At the transport/sidecar boundary, the sidecar must make ZERO provider
 * (Edge/NaN) calls until an explicit POST /speech arrives:
 *
 *   start Desktop / sidecar startup      → zero provider requests
 *   /health (engines descriptor, cache)  → zero provider requests
 *   /cancel (in-flight management)       → zero provider requests
 *   Play/Export (POST /speech)           → synthesis may begin
 *
 * A counting provider makes any lazy/eager network activity visible: if the
 * sidecar (or a provider constructor) ever pre-connected or warmed up, the
 * counter would move before the first /speech.
 */
import { afterAll, describe, expect, it } from "vitest";
import type { EngineRuntime } from "@/server/config";
import { loadConfig } from "@/server/config";
import type { SpeechProvider, SpeechRequest, SpeechResult } from "@/domain/speech/types";
import { buildWav } from "@/adapters/speech-providers/mock-provider";
import { FileAudioCache } from "@/infrastructure/cache/file-audio-cache";
import { SlidingWindowRateLimiter } from "@/server/rate-limit";
import { createLogger } from "@/infrastructure/logging/logger";
import { createSidecarApp, type SidecarApp } from "../../sidecar/app";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const TOKEN = "privacy-gate-token-0123456789abcdef";

function countingProvider(name: string): SpeechProvider & { callCount: () => number } {
  let count = 0;
  return {
    name,
    synthesize(request: SpeechRequest): Promise<SpeechResult> {
      count += 1;
      void request;
      return Promise.resolve({
        audio: buildWav("privacy"),
        mimeType: "audio/wav",
      });
    },
    callCount: () => count,
  };
}

function makeEngine(
  id: string,
  provider: SpeechProvider & { callCount: () => number },
): EngineRuntime {
  return {
    id,
    label: id === "edge" ? "Edge TTS" : "Estándar",
    provider,
    model: `model-${id}`,
    defaultVoice: "v1",
    format: "wav",
  };
}

describe("privacy gate: zero provider traffic before Play", () => {
  let app: SidecarApp | null = null;
  let dir: string | null = null;

  afterAll(async () => {
    if (app) await app.shutdown();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("performs no provider calls during startup, health or cancel; only /speech synthesizes", async () => {
    const std = countingProvider("counting-std");
    const edge = countingProvider("counting-edge");
    dir = mkdtempSync(join(tmpdir(), "docuvoz-privacy-"));
    const config = loadConfig({
      SPEECH_PROVIDER: "mock",
      LOG_LEVEL: "error",
      SPEECH_CACHE_DIR: dir,
      API_RATE_LIMIT_PER_MINUTE: "1000",
    });
    const engines = [makeEngine("default", std), makeEngine("edge", edge)];
    app = createSidecarApp({
      token: TOKEN,
      deps: {
        config,
        provider: engines[0].provider,
        engines,
        cache: new FileAudioCache(config.SPEECH_CACHE_DIR),
        limiter: new SlidingWindowRateLimiter(config.API_RATE_LIMIT_PER_MINUTE),
        logger: createLogger({ component: "test" }),
      },
    });
    const port = await app.listen(0);
    const base = `http://127.0.0.1:${port}`;
    const auth = { authorization: `Bearer ${TOKEN}` };

    // -- sidecar startup: constructed engines, zero provider activity.
    expect(std.callCount()).toBe(0);
    expect(edge.callCount()).toBe(0);

    // -- app open / navigation: the only speech-channel calls the UI may
    // make before Play are health checks and cancels.
    for (let i = 0; i < 3; i++) {
      const health = await fetch(`${base}/health`, { headers: auth });
      expect(health.status).toBe(200);
    }
    const cancel = await fetch(`${base}/cancel/nonexistent`, {
      method: "POST",
      headers: auth,
    });
    expect(cancel.status).toBe(204);

    expect(std.callCount()).toBe(0);
    expect(edge.callCount()).toBe(0);

    // -- unauthorized requests must not be able to poke the surface either.
    const unauth = await fetch(`${base}/speech`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x" }),
    });
    expect(unauth.status).toBe(401);
    expect(std.callCount()).toBe(0);
    expect(edge.callCount()).toBe(0);

    // -- Play: the FIRST synthesis request is what triggers a provider call.
    const play = await fetch(`${base}/speech?requestId=req-1`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ text: "Primer fragmento" }),
    });
    expect(play.status).toBe(200);
    expect(std.callCount()).toBe(1);
    expect(edge.callCount()).toBe(0);

    // -- explicit engine routing: only the addressed engine synthesizes.
    const playEdge = await fetch(`${base}/speech?requestId=req-2`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ text: "Segundo", engine: "edge" }),
    });
    expect(playEdge.status).toBe(200);
    expect(std.callCount()).toBe(1);
    expect(edge.callCount()).toBe(1);
  });
});
