/**
 * Smoke-test a sidecar binary (packaged or `node sidecar/dist/server.js`).
 *
 * Contract checked (the same mechanism Rust uses):
 *   spawn -> single READY {"port":N} line on stdout (bounded timeout)
 *   GET /health (bearer)          -> engines descriptor
 *   POST /speech (mock)           -> binary frame with WAV audio
 *   --edge: POST /speech (edge)   -> real mp3 + word boundaries from the
 *         bundled msedge-tts (network required). This is the packager
 *         acceptance gate: the packaged binary must speak real Edge.
 *   kill -> process exits
 *
 * Usage: node scripts/smoke-sidecar.mjs <path-to-sidecar> [--edge]
 */
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const binary = process.argv[2];
const withEdge = process.argv.includes("--edge");
if (!binary) {
  console.error("usage: node scripts/smoke-sidecar.mjs <path-to-sidecar> [--edge]");
  process.exit(64);
}

const TOKEN = `smoke-${process.pid}-${Date.now()}`;
const cacheDir = mkdtempSync(join(tmpdir(), "docuvoz-sidecar-smoke-"));
const child = spawn(binary, [], {
  env: {
    ...process.env,
    DOCUVOZ_SIDECAR_TOKEN: TOKEN,
    EDGE_TTS_ENABLED: "1",
    SPEECH_CACHE_DIR: cacheDir,
    LOG_LEVEL: "error",
  },
  stdio: ["ignore", "pipe", "pipe"],
});

function fail(message) {
  console.error(`SMOKE FAILED: ${message}`);
  child.kill();
  try {
    rmSync(cacheDir, { recursive: true, force: true });
  } catch {}
  process.exit(1);
}

// 1. bounded READY handshake from stdout
const handshake = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("no READY line within 15s")), 15000);
  let stdout = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf-8");
    const match = /^READY (\{.*\})$/.exec(stdout.split("\n")[0].trim());
    if (match) {
      clearTimeout(timer);
      resolve(JSON.parse(match[1]));
    }
  });
  child.once("exit", (code) => reject(new Error(`exited before READY (code ${code})`)));
}).catch((error) => fail(error.message));

console.log(`ready on 127.0.0.1:${handshake.port}`);

const auth = { authorization: `Bearer ${TOKEN}` };
const base = `http://127.0.0.1:${handshake.port}`;

function parseFrame(buffer) {
  const view = new DataView(buffer);
  const metadataLength = view.getUint32(0, true);
  const metadata = JSON.parse(
    new TextDecoder().decode(new Uint8Array(buffer, 4, metadataLength)),
  );
  return { metadata, audio: new Uint8Array(buffer, 4 + metadataLength) };
}

// 2. health
const health = await fetch(`${base}/health`, { headers: auth });
if (!health.ok) fail(`health failed: ${health.status}`);
const descriptor = await health.json();
if (!descriptor.ok) fail("health descriptor not ok");

// 3. mock synthesis through the frame protocol
const mock = await fetch(`${base}/speech`, {
  method: "POST",
  headers: { ...auth, "content-type": "application/json" },
  body: JSON.stringify({ text: "Comprobación del sidecar empaquetado" }),
});
const mockFrame = parseFrame(await mock.arrayBuffer());
if (mockFrame.metadata.mimeType !== "audio/wav") fail("mock frame wrong mime");
if (String.fromCharCode(...mockFrame.audio.slice(0, 4)) !== "RIFF")
  fail("mock audio not WAV");
console.log("mock frame ok (wav)");

if (withEdge) {
  const edge = await fetch(`${base}/speech`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({
      text: "Hola, esta es una prueba de voz real desde el sidecar empaquetado.",
      engine: "edge",
      voice: "es-ES-XimenaNeural",
    }),
  });
  const edgeFrame = parseFrame(await edge.arrayBuffer());
  if (edgeFrame.metadata.error) fail(`edge frame error: ${edgeFrame.metadata.error}`);
  if (!String(edgeFrame.metadata.mimeType).includes("mpeg")) {
    fail(`edge mime wrong: ${edgeFrame.metadata.mimeType}`);
  }
  if (edgeFrame.audio.byteLength < 1000) fail("edge audio too small");
  const magic = edgeFrame.audio.slice(0, 3);
  const isMp3 =
    (magic[0] === 0x49 && magic[1] === 0x44 && magic[2] === 0x33) || // ID3
    (magic[0] === 0xff && (magic[1] & 0xe0) === 0xe0); // MPEG sync
  if (!isMp3) fail(`edge audio not mp3 (magic ${magic.join(",")})`);
  const boundaries = edgeFrame.metadata.boundaries;
  if (!Array.isArray(boundaries) || boundaries.length === 0)
    fail("edge frame has no boundaries");
  console.log(
    `edge frame ok (mp3 ${edgeFrame.audio.byteLength} bytes, ${boundaries.length} boundaries)`,
  );
}

child.kill();
const exited = await Promise.race([
  new Promise((resolve) => child.once("exit", () => resolve(true))),
  new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
]);
try {
  rmSync(cacheDir, { recursive: true, force: true });
} catch {}
if (!exited) fail("sidecar did not exit after kill (orphan process)");
console.log("SMOKE PASSED");
