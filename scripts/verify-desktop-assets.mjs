/**
 * Build gate: verify that required PDF.js runtime assets exist in
 * desktop/public/pdfjs before Tauri packaging. Fail the build if any
 * required asset is missing so the regression cannot ship silently.
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pdfjsDir = join(root, "desktop", "public", "pdfjs");

const errors = [];

// 1. Worker file
const worker = join(pdfjsDir, "pdf.worker.min.mjs");
if (!existsSync(worker) || statSync(worker).size === 0) {
  errors.push("Missing or empty: desktop/public/pdfjs/pdf.worker.min.mjs");
}

// 2. Standard fonts directory
const fontsDir = join(pdfjsDir, "standard_fonts");
if (!existsSync(fontsDir) || !statSync(fontsDir).isDirectory()) {
  errors.push("Missing directory: desktop/public/pdfjs/standard_fonts/");
} else {
  const files = readdirSync(fontsDir);
  if (files.length === 0) {
    errors.push("Empty directory: desktop/public/pdfjs/standard_fonts/");
  }
  // Expect at least the LiberationSans fonts that pdfjs-dist bundles
  const expected = ["LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf"];
  for (const name of expected) {
    if (!files.includes(name)) {
      errors.push(`Missing standard font: ${name}`);
    }
  }
}

if (errors.length > 0) {
  console.error("\n[verify-desktop-assets] FAILED — required PDF.js assets missing:\n");
  for (const e of errors) console.error(`  - ${e}`);
  console.error(
    "\nRun `npm run setup:pdfjs` or `npm run prebuild:desktop` before packaging.\n",
  );
  process.exit(1);
}

console.log("[verify-desktop-assets] OK — all required PDF.js assets present");
