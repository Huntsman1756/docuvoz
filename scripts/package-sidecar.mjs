/**
 * Package the speech sidecar as a self-contained Tauri external binary.
 *
 * Steps:
 *   1. esbuild-bundle sidecar/server.ts -> sidecar/dist/server.js (via
 *      `npm run sidecar:build`), including msedge-tts and its runtime deps.
 *   2. Package it with @yao-pkg/pkg for the HOST target triplet (from
 *      `rustc --print host-tuple`) into
 *      src-tauri/binaries/docuvoz-speech-<triplet>[.exe]
 *
 * The Node runtime matches the project requirement (^24): pkg-fetch provides
 * node24 base binaries. No target triple is hardcoded for Tauri — the binary
 * name carries the triplet and Tauri resolves `externalBin` accordingly.
 */
import { exec as pkgExec } from "@yao-pkg/pkg";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { execFileSync } from "node:child_process";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const bundle = join(root, "sidecar", "dist", "server.js");
const outDir = join(root, "src-tauri", "binaries");

const hostTuple = execFileSync("rustc", ["--print", "host-tuple"], {
  encoding: "utf8",
}).trim();

/** rustc triple -> pkg target (node24 base binary). */
const PKG_TARGETS = {
  "x86_64-pc-windows-msvc": "node24-win-x64",
  "aarch64-apple-darwin": "node24-macos-arm64",
  "x86_64-apple-darwin": "node24-macos-x64",
};
const pkgTarget = PKG_TARGETS[hostTuple];
if (!pkgTarget) {
  throw new Error(`no pkg target mapping for host tuple ${hostTuple}`);
}

// 1. fresh esbuild bundle
execFileSync(process.execPath, [join(root, "scripts", "build-sidecar.mjs")], {
  stdio: "inherit",
});

// 2. package into src-tauri/binaries/docuvoz-speech-<triplet>[.exe]
const ext = hostTuple.includes("windows") ? ".exe" : "";
const output = join(outDir, `docuvoz-speech-${hostTuple}${ext}`);
rmSync(output, { force: true });
mkdirSync(outDir, { recursive: true });

await pkgExec([bundle, "--target", pkgTarget, "--output", output, "--compress", "GZip"]);

console.log(`sidecar packaged -> ${output}`);
