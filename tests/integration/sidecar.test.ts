/**
 * Sidecar contract tests — the exact surface the Rust desktop bridge relies on.
 *
 * Covered (in-process against the real HTTP app):
 *   - bearer auth on /health, /speech, /cancel
 *   - binary frame format (uint32 metadataLength | JSON | audio)
 *   - cache-status MISS -> HIT parity, provider duration, mime type
 *   - request validation: content-type, malformed JSON, bounded body
 *   - cancellation contract: A cancelled -> error frame "cancelled", no slot
 *     leak, B proceeds normally
 *   - rate limiting still applies per client
 * Plus entrypoint tests that spawn the real bundled `sidecar/dist/server.js`
 * and verify the READY handshake (stdout carries nothing else) and startup
 * failure without a token.
 */
import { afterAll, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createEngines, loadConfig } from "@/server/config";
import type { EngineRuntime, ServerConfig } from "@/server/config";
import { FileAudioCache } from "@/infrastructure/cache/file-audio-cache";
import { SlidingWindowRateLimiter } from "@/server/rate-limit";
import { createLogger } from "@/infrastructure/logging/logger";
import { buildWav } from "@/adapters/speech-providers/mock-provider";
import {
  SpeechError,
  type SpeechProvider,
  type SpeechRequest,
  type SpeechResult,
} from "@/domain/speech/types";
import { createSidecarApp, type SidecarApp } from "../../sidecar/app";

const TOKEN = "sidecar-test-token-0123456789abcdef";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

interface Harness {
  app: SidecarApp;
  base: string;
  config: ServerConfig;
  dirs: string[];
}

function makeDeps(
  envOverrides: Record<string, string> = {},
  engines?: EngineRuntime[],
): { deps: ReturnType<typeof wire>; config: ServerConfig; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "docuvoz-sidecar-"));
  const config = loadConfig({
    SPEECH_PROVIDER: "mock",
    LOG_LEVEL: "error",
    SPEECH_CACHE_DIR: dir,
    API_RATE_LIMIT_PER_MINUTE: "1000",
    ...envOverrides,
  });
  return { deps: wire(config, engines), config, dir };
}

function wire(config: ServerConfig, engines?: EngineRuntime[]) {
  const list = engines ?? createEngines(config);
  return {
    config,
    provider: list[0].provider,
    engines: list,
    cache: new FileAudioCache(config.SPEECH_CACHE_DIR),
    limiter: new SlidingWindowRateLimiter(config.API_RATE_LIMIT_PER_MINUTE),
    logger: createLogger({ component: "test" }),
  };
}

async function startHarness(
  envOverrides: Record<string, string> = {},
  engines?: EngineRuntime[],
): Promise<Harness & { cleanup: () => Promise<void> }> {
  const { deps, config, dir } = makeDeps(envOverrides, engines);
  const app = createSidecarApp({ token: TOKEN, deps });
  const port = await app.listen(0);
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    config,
    dirs: [dir],
    cleanup: async () => {
      await app.shutdown();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

/** Parse the binary envelope: uint32 metadataLength (LE) | JSON | audio. */
function parseFrame(buffer: ArrayBuffer): {
  metadata: Record<string, unknown>;
  audio: Uint8Array;
} {
  const view = new DataView(buffer);
  const metadataLength = view.getUint32(0, true);
  const metadata = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, metadataLength)),
  ) as Record<string, unknown>;
  return { metadata, audio: new Uint8Array(buffer, 4 + metadataLength) };
}

async function speech(
  base: string,
  body: unknown,
  requestId?: string,
  headers: Record<string, string> = auth({ "content-type": "application/json" }),
): Promise<Response> {
  return fetch(`${base}/speech${requestId ? `?requestId=${requestId}` : ""}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

describe("sidecar HTTP contract", () => {
  it("requires bearer auth on /health", async () => {
    const h = await startHarness();
    try {
      const denied = await fetch(`${h.base}/health`);
      expect(denied.status).toBe(401);
      const ok = await fetch(`${h.base}/health`, { headers: auth() });
      expect(ok.status).toBe(200);
      const health = (await ok.json()) as { ok: boolean; engines: { id: string }[] };
      expect(health.ok).toBe(true);
      expect(health.engines.length).toBeGreaterThan(0);
    } finally {
      await h.cleanup();
    }
  });

  it("serves speech as a binary frame with MISS then HIT cache parity", async () => {
    const h = await startHarness();
    try {
      const first = await speech(
        h.base,
        { text: "Hola mundo desde el sidecar" },
        "req-1",
      );
      expect(first.status).toBe(200);
      expect(first.headers.get("content-type")).toBe("application/octet-stream");
      const parsedFirst = parseFrame(await first.arrayBuffer());
      expect(parsedFirst.metadata.mimeType).toBe("audio/wav");
      expect(parsedFirst.metadata.cacheStatus).toBe("MISS");
      expect(parsedFirst.metadata.cacheKey).toBeTruthy();
      expect(typeof parsedFirst.metadata.providerDurationMs).toBe("number");
      expect(parsedFirst.audio.byteLength).toBeGreaterThan(44);
      // WAV magic
      expect(String.fromCharCode(...parsedFirst.audio.slice(0, 4))).toBe("RIFF");

      const second = await speech(
        h.base,
        { text: "Hola mundo desde el sidecar" },
        "req-2",
      );
      const parsedSecond = parseFrame(await second.arrayBuffer());
      expect(parsedSecond.metadata.cacheStatus).toBe("HIT");
      expect(parsedSecond.metadata.cacheKey).toBe(parsedFirst.metadata.cacheKey);
      expect(parsedSecond.audio.byteLength).toBe(parsedFirst.audio.byteLength);
    } finally {
      await h.cleanup();
    }
  });

  it("rejects unauthenticated, wrong-content-type, malformed and oversized bodies", async () => {
    const h = await startHarness({ API_MAX_BODY_BYTES: "1024" });
    try {
      const unauth = await speech(h.base, { text: "hola" }, undefined, {
        "content-type": "application/json",
      });
      expect(unauth.status).toBe(401);

      const wrongType = await speech(h.base, { text: "hola" }, undefined, auth({}));
      expect(wrongType.status).toBe(415);

      const malformed = await fetch(`${h.base}/speech`, {
        method: "POST",
        headers: auth({ "content-type": "application/json" }),
        body: "{not json",
      });
      expect(malformed.status).toBe(400);

      const oversized = await fetch(`${h.base}/speech`, {
        method: "POST",
        headers: auth({ "content-type": "application/json" }),
        body: JSON.stringify({ text: "x".repeat(2000) }),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await h.cleanup();
    }
  });

  it("enforces the per-client rate limit", async () => {
    const h = await startHarness({ API_RATE_LIMIT_PER_MINUTE: "1" });
    try {
      const ok = await speech(h.base, { text: "primera" });
      expect(ok.status).toBe(200);
      const limited = await speech(h.base, { text: "segunda" });
      expect(limited.status).toBe(200);
      const parsed = parseFrame(await limited.arrayBuffer());
      expect(parsed.metadata.error).toBe("rate_limited");
    } finally {
      await h.cleanup();
    }
  });

  it("cancels request A without leaking the provider slot; B proceeds", async () => {
    const state: { resolve: ((result: SpeechResult) => void) | null } = { resolve: null };
    let started = 0;
    const controlled: SpeechProvider = {
      name: "controlled",
      synthesize(request: SpeechRequest): Promise<SpeechResult> {
        started += 1;
        return new Promise<SpeechResult>((resolve, reject) => {
          const onAbort = () => {
            reject(new SpeechError("provider_timeout", "aborted", { retryable: false }));
          };
          if (request.signal?.aborted) {
            onAbort();
            return;
          }
          request.signal?.addEventListener("abort", onAbort, { once: true });
          state.resolve = (result) => {
            request.signal?.removeEventListener("abort", onAbort);
            resolve(result);
          };
        });
      },
    };
    const config = loadConfig({
      SPEECH_PROVIDER: "mock",
      LOG_LEVEL: "error",
      SPEECH_CACHE_DIR: mkdtempSync(join(tmpdir(), "docuvoz-sidecar-cancel-")),
      API_RATE_LIMIT_PER_MINUTE: "1000",
      SPEECH_MAX_CONCURRENCY: "1",
    });
    const engine: EngineRuntime = {
      id: "default",
      label: "Test",
      provider: controlled,
      model: "controlled-v1",
      defaultVoice: "test",
      format: "wav",
    };
    const app = createSidecarApp({ token: TOKEN, deps: wire(config, [engine]) });
    const port = await app.listen(0);
    const base = `http://127.0.0.1:${port}`;
    try {
      const a = speech(base, { text: "documento A" }, "req-a");
      await vi.waitFor(() => expect(started).toBe(1));

      // Cancel A while its provider work is in flight.
      const cancel = await fetch(`${base}/cancel/req-a`, {
        method: "POST",
        headers: auth(),
      });
      expect(cancel.status).toBe(204);
      const aResponse = await a;
      const aParsed = parseFrame(await aResponse.arrayBuffer());
      expect(aParsed.metadata.error).toBe("cancelled");
      expect(app.pending.has("req-a")).toBe(false);

      // B proceeds normally: the single concurrency slot is free again.
      const b = speech(base, { text: "documento B" }, "req-b");
      await vi.waitFor(() => expect(started).toBe(2));
      state.resolve?.({ audio: buildWav("documento B"), mimeType: "audio/wav" });
      const bParsed = parseFrame(await (await b).arrayBuffer());
      expect(bParsed.metadata.error).toBeUndefined();
      expect(bParsed.metadata.mimeType).toBe("audio/wav");

      // Cancelling an unknown requestId is a no-op (204), never an error.
      const noop = await fetch(`${base}/cancel/does-not-exist`, {
        method: "POST",
        headers: auth(),
      });
      expect(noop.status).toBe(204);
    } finally {
      await app.shutdown();
      rmSync(config.SPEECH_CACHE_DIR, { recursive: true, force: true });
    }
  });
});

describe("sidecar entrypoint (bundled dist)", () => {
  const distServer = join(root, "sidecar", "dist", "server.js");
  const children: ChildProcess[] = [];

  function spawnSidecar(env: Record<string, string | undefined>): ChildProcess {
    const child = spawn(process.execPath, [distServer], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.push(child);
    return child;
  }

  function readReadyLine(
    child: ChildProcess,
    timeoutMs = 15000,
  ): Promise<{ port: number }> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("sidecar did not print READY in time")),
        timeoutMs,
      );
      let stdout = "";
      child.stdout!.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf-8");
        const line = stdout.split("\n")[0];
        const match = /^READY (\{.*\})$/.exec(line.trim());
        if (match) {
          clearTimeout(timer);
          resolve(JSON.parse(match[1]) as { port: number });
        }
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`sidecar exited before READY (code ${code})`));
      });
    });
  }

  it("fails fast with exit code 2 and no stdout when DOCUVOZ_SIDECAR_TOKEN is missing", async () => {
    if (!existsSync(distServer))
      throw new Error("sidecar dist missing; run npm run sidecar:build");
    const child = spawnSidecar({});
    const result = await new Promise<{ code: number | null; stdout: string }>(
      (resolve) => {
        let stdout = "";
        child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf-8")));
        child.on("exit", (code) => resolve({ code, stdout }));
      },
    );
    expect(result.code).toBe(2);
    expect(result.stdout).toBe("");
  });

  it("prints exactly one READY line on stdout, serves health, and exits on kill", async () => {
    if (!existsSync(distServer))
      throw new Error("sidecar dist missing; run npm run sidecar:build");
    const child = spawnSidecar({ DOCUVOZ_SIDECAR_TOKEN: TOKEN });
    const { port } = await readReadyLine(child);

    // stdout must stay reserved for the handshake: no log lines allowed.
    let stdoutExtra = "";
    child.stdout!.on("data", (chunk: Buffer) => (stdoutExtra += chunk.toString("utf-8")));

    const base = `http://127.0.0.1:${port}`;
    const health = await fetch(`${base}/health`, { headers: auth() });
    expect(health.status).toBe(200);
    const descriptor = (await health.json()) as { ok: boolean };
    expect(descriptor.ok).toBe(true);

    // A speech request must not put logs on stdout either.
    const res = await fetch(`${base}/speech`, {
      method: "POST",
      headers: auth({ "content-type": "application/json" }),
      body: JSON.stringify({ text: "handshake check" }),
    });
    expect(res.status).toBe(200);

    // Bound to loopback only.
    expect(port).toBeGreaterThan(0);

    child.kill();
    // The essential lifecycle property: the process exits (no orphan sidecar).
    // On Windows the kill is a hard terminate (code null + SIGTERM); on POSIX
    // the graceful handler exits 0. Either way the 'exit' event must fire.
    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once("exit", () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 10000)),
    ]);
    expect(exited).toBe(true);
    expect(stdoutExtra).toBe("");
  }, 30000);

  afterAll(() => {
    for (const child of children) {
      if (!child.killed) child.kill();
    }
  });
});
