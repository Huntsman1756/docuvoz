/**
 * Regenerates the deterministic, committed multi-format corpus fixtures:
 *
 *   public/corpus/docs/docuviz-sample.epub   (EPUB3, nested TOC, table, note)
 *   public/corpus/docs/docuviz-sample.docx   (headings/lists/table/link/footnote)
 *
 * Content is 100% synthetic original Spanish text authored for this repo —
 * no copyrighted material. Output is byte-deterministic (fixed entry
 * timestamps + fixed deflate level), so `npm run fixtures:generate` is a
 * no-op diff when fixtures are current.
 *
 * Run: npx tsx scripts/generate-format-fixtures.ts
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildSampleEpub, buildSampleDocx } from "../tests/e2e/helpers/doc-fixtures";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

async function emit(fixture: { name: string; buffer: Buffer }, relPath: string) {
  const full = join(root, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, fixture.buffer);
  const sha = createHash("sha256").update(fixture.buffer).digest("hex").slice(0, 16);
  console.log(`${relPath}  ${fixture.buffer.length} bytes  sha256:${sha}…`);
}

async function main() {
  await emit(await buildSampleEpub(), "public/corpus/docs/docuviz-sample.epub");
  await emit(await buildSampleDocx(), "public/corpus/docs/docuviz-sample.docx");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
