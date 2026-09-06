/**
 * Populate `desktop/public` for the static (Tauri) build.
 *
 * Copies only files tracked by git under the root `public/` (fixtures,
 * corpus entries referenced by the reader/lab) plus the regenerated pdf.js
 * assets. Git-ignored local artifacts (evaluation outputs, local corpus)
 * are deliberately excluded so the desktop build is reproducible.
 */
import { copyFileSync, mkdirSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const destRoot = join(root, "desktop", "public");

const tracked = execFileSync("git", ["ls-files", "public"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .map((line) => line.trim())
  .filter(Boolean);

let copied = 0;
for (const rel of tracked) {
  const source = join(root, rel);
  const dest = join(destRoot, rel.slice("public/".length));
  if (!existsSync(source)) continue; // e.g. deleted between ls and copy
  mkdirSync(dirname(dest), { recursive: true });
  copyFileSync(source, dest);
  copied += 1;
}
console.log(`[desktop:public] copied ${copied} tracked public file(s)`);

// pdf.js worker + standard fonts (regenerated from node_modules).
execFileSync(process.execPath, [join(root, "scripts", "copy-pdf-worker.mjs"), destRoot], {
  stdio: "inherit",
});
