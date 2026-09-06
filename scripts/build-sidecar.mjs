/**
 * Bundle the speech sidecar into a single self-contained CommonJS file.
 *
 * The bundle is used two ways:
 *   1. run directly with the system Node (`node sidecar/dist/server.js`)
 *   2. packaged by @yao-pkg/pkg into the Tauri external binary
 *      (`docuvoz-speech-<target-triple>`)
 *
 * Everything is bundled, including `msedge-tts` and its runtime dependencies
 * (axios, ws, isomorphic-ws) so the packaged binary needs no node_modules.
 */
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(root, "sidecar", "dist", "server.js");

await build({
  entryPoints: [join(root, "sidecar", "server.ts")],
  bundle: true,
  platform: "node",
  target: "node24",
  format: "cjs",
  outfile,
  tsconfig: join(root, "tsconfig.json"),
  sourcemap: false,
  logLevel: "info",
  banner: { js: "/* DocuVoz speech sidecar (bundled by esbuild). */" },
});

console.log(`sidecar bundled -> ${outfile}`);
