/**
 * Copy the pdf.js worker (and the standard-font data pdf.js needs for
 * non-embedded fonts) into /public/pdfjs so the browser extractor works with
 * stable, framework-agnostic URLs. Everything here is regenerated from
 * node_modules and is git-ignored — run via predev / prebuild, or manually
 * with `npm run setup:pdfjs`.
 */
import { copyFileSync, mkdirSync, existsSync, statSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const pkg = resolve(root, "node_modules", "pdfjs-dist");

if (!existsSync(pkg)) {
  console.error("[setup:pdfjs] pdfjs-dist not installed. Run `npm install` first.");
  process.exit(1);
}

const targetDir = join(root, "public", "pdfjs");
mkdirSync(targetDir, { recursive: true });

// 1. Worker.
const workerCandidates = ["pdf.worker.min.mjs", "pdf.worker.mjs"].map((name) =>
  join(pkg, "build", name),
);
const worker = workerCandidates.find((p) => existsSync(p));
if (!worker) {
  console.error("[setup:pdfjs] pdf.js worker not found in node_modules.");
  process.exit(1);
}
const workerTarget = join(targetDir, "pdf.worker.min.mjs");
if (!existsSync(workerTarget) || statSync(workerTarget).size !== statSync(worker).size) {
  copyFileSync(worker, workerTarget);
  console.log("[setup:pdfjs] copied pdf.js worker");
}

// 2. Standard fonts (glyph data for non-embedded base-14 fonts).
const fontsSource = join(pkg, "standard_fonts");
const fontsTarget = join(targetDir, "standard_fonts");
if (existsSync(fontsSource)) {
  mkdirSync(fontsTarget, { recursive: true });
  const files = readdirSync(fontsSource);
  let copied = 0;
  for (const file of files) {
    const target = join(fontsTarget, file);
    if (
      !existsSync(target) ||
      statSync(target).size !== statSync(join(fontsSource, file)).size
    ) {
      copyFileSync(join(fontsSource, file), target);
      copied += 1;
    }
  }
  if (copied > 0) console.log(`[setup:pdfjs] copied ${copied} standard font file(s)`);
}
