/**
 * Generate all corpus artifacts from the synthetic fixture definitions:
 *   - browser-renderable PDFs (public/corpus/pdfs)
 *   - reference (desktop-parser-shaped) JSON exports (public/corpus/reference)
 *   - Manual Gold JSON for G3a (public/corpus/gold)
 *   - manifest (public/corpus/manifest.json)
 *
 * No real copyrighted regulation is ever written. Re-run with:
 *   npm run fixtures
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPdf } from "./pdf-writer.mjs";
import { fixtures } from "./fixtures-def.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const outPdf = join(root, "public", "corpus", "pdfs");
const outRef = join(root, "public", "corpus", "reference");
const outGold = join(root, "public", "corpus", "gold");
for (const dir of [outPdf, outRef, outGold]) mkdirSync(dir, { recursive: true });

const SIZE_BY_TYPE = { heading: 14 };

function blockLines(block) {
  return [
    {
      text: block.text,
      size: SIZE_BY_TYPE[block.type] ?? 10,
      bold: block.type === "heading",
      gap: block.type === "heading" ? 9 : 6,
    },
  ];
}

function pagesFromFixture(fx) {
  const pages = new Map();
  for (const block of fx.blocks) {
    if (!pages.has(block.page)) pages.set(block.page, []);
    pages.get(block.page).push(...blockLines(block));
  }
  const maxPage = Math.max(...fx.blocks.map((b) => b.page));
  const out = [];
  for (let p = 1; p <= maxPage; p++) {
    out.push({
      header: fx.chrome.header,
      footer: fx.chrome.footer,
      pageNumber: `página ${p}`,
      lines: pages.get(p) ?? [],
    });
  }
  return out;
}

function referenceDocument(fx) {
  const blocks = [];
  let order = 0;
  const pageOrder = [...new Set(fx.blocks.map((b) => b.page))].sort((a, b) => a - b);
  for (const page of pageOrder) {
    if (fx.chrome.header) {
      blocks.push({
        id: `b${order}`,
        type: "page-header",
        text: fx.chrome.header,
        page,
        order: order++,
      });
    }
    for (const block of fx.blocks.filter((b) => b.page === page)) {
      const entry = {
        id: `b${order}`,
        type: block.type,
        text: block.text,
        page,
        order: order++,
      };
      if (block.type === "heading")
        entry.level = block.text.startsWith("CAPÍTULO") ? 1 : 2;
      if (block.type === "list-item") entry.listLevel = 0;
      blocks.push(entry);
    }
    if (fx.chrome.footer) {
      blocks.push({
        id: `b${order}`,
        type: "page-footer",
        text: fx.chrome.footer,
        page,
        order: order++,
      });
    }
    blocks.push({
      id: `b${order}`,
      type: "page-number",
      text: `página ${page}`,
      page,
      order: order++,
    });
  }
  return {
    id: `ref-${fx.id}`,
    source: {
      name: `${fx.id}.pdf`,
      pageCount: pageOrder.length,
      language: "es",
    },
    blocks,
    parser: "docling-reference-export",
    parserVersion: "0.0.0-synthetic",
  };
}

function goldFile(fx, refDoc) {
  if (!fx.gold) return null;
  // fx.gold.blockIndex references the i-th *non-chrome* block, which appears
  // in the reference document in the same relative order (excluding header /
  // footer / page-number synthetic chrome injected by the generator).
  const contentBlocks = refDoc.blocks.filter(
    (b) =>
      b.type !== "page-header" && b.type !== "page-footer" && b.type !== "page-number",
  );
  return {
    fixtureId: fx.id,
    notice:
      "Manual Gold is a human-authored spoken upper bound for experiments (gate G3a). It is never produced by the automatic engine.",
    entries: fx.gold.map((g) => ({
      blockId: contentBlocks[g.blockIndex].id,
      spokenText: g.spoken,
    })),
  };
}

/**
 * Manual Gold is human-authored experimental data (G3a/G4B). The def file
 * (scripts/fixtures-def.mjs) is its canonical carrier so that regeneration
 * is reproducible — but regeneration must NEVER silently degrade the human
 * record. Fail loudly if the def would drop or mutate an existing gold
 * entry: add it to the def first (verbatim, human text) or restore the
 * gold JSON deliberately from git.
 */
function guardGoldRegression(path, next) {
  if (!existsSync(path)) return;
  let prev;
  try {
    prev = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return; // unreadable file will be overwritten; nothing to compare
  }
  const problems = [];
  for (const e of prev.entries ?? []) {
    const match = next.entries.find((n) => n.blockId === e.blockId);
    if (!match) problems.push(`${e.blockId}: present on disk, missing from def`);
    else if (match.spokenText !== e.spokenText)
      problems.push(`${e.blockId}: spoken text differs from def`);
  }
  if (problems.length > 0) {
    throw new Error(
      `gold regression guard: refusing to rewrite ${path}\n` +
        problems.map((p) => `  - ${p}`).join("\n"),
    );
  }
}

const manifestEntries = [];

for (const fx of fixtures) {
  const pdf = buildPdf(pagesFromFixture(fx));
  writeFileSync(join(outPdf, `${fx.id}.pdf`), pdf);
  const refDoc = referenceDocument(fx);
  writeFileSync(join(outRef, `${fx.id}.json`), JSON.stringify(refDoc, null, 2));
  const gold = goldFile(fx, refDoc);
  if (gold) guardGoldRegression(join(outGold, `${fx.id}.json`), gold);
  if (gold) writeFileSync(join(outGold, `${fx.id}.json`), JSON.stringify(gold, null, 2) + "\n");

  manifestEntries.push({
    id: fx.id,
    title: fx.title,
    category: fx.category,
    description: fx.description,
    pdf: `/corpus/pdfs/${fx.id}.pdf`,
    reference: `/corpus/reference/${fx.id}.json`,
    ...(gold ? { gold: `/corpus/gold/${fx.id}.json` } : {}),
    synthetic: true,
  });
}

const manifest = {
  version: 1,
  notice:
    "All fixtures are synthetic and legally safe to redistribute. Real Spanish regulatory texts (BOE/CNMV/Banco de España/EUR-Lex) may have redistribution restrictions; corpus/README.md explains how to add local, uncommitted real-world documents and how their hashes are recorded.",
  entries: manifestEntries,
};
writeFileSync(
  join(root, "public", "corpus", "manifest.json"),
  JSON.stringify(manifest, null, 2),
);

console.log(`Generated ${manifestEntries.length} fixtures into public/corpus/`);
