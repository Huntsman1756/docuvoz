/**
 * G2 — extraction evaluation.
 *
 * Compares the browser extraction pipeline (pdf.js + heuristics) against the
 * reference (Docling-shaped) export for each corpus fixture, answering:
 * how much structure survives the move to interactive client-side parsing?
 *
 * Run: npm run eval:extraction
 */
import {
  assetPath,
  CHROME_TYPES,
  contentBlocks,
  diceSimilarity,
  extractWithBrowserPipeline,
  loadManifest,
  loadReference,
  normalizeText,
  writeResult,
  type CorpusEntry,
} from "./shared";
import type { StructuredDocument } from "../../src/domain/documents/types";

interface FixtureResult {
  fixtureId: string;
  category: string;
  referenceBlocks: number;
  browserBlocks: number;
  /** Word-level Dice over concatenated non-chrome text. */
  textFidelity: number;
  /** Fraction of reference content blocks recovered by some browser block. */
  contentRecall: number;
  /** Recovered blocks placed on the same page as in the reference. */
  pageAccuracy: number | null;
  /** True when matched blocks preserve the reference reading order. */
  readingOrderMonotonic: boolean;
  /** Reference heading blocks recovered AS headings by the browser path. */
  headingDetection: { reference: number; recovered: number };
  listDetection: { reference: number; recovered: number };
  footnoteDetection: { reference: number; recovered: number };
  /** Known gap: browser path never detects tables. Recorded, not hidden. */
  tableCells: { reference: number; recovered: number };
  chromeClassification: { reference: number; recovered: number };
  /** Browser blocks carrying page + bbox provenance. */
  provenanceCoverage: number;
  missed: { text: string; type: string }[];
  misclassified: { text: string; expected: string; got: string | null }[];
}

const MATCH_THRESHOLD = 0.55;

/** Greedy best-match of each reference content block to a browser block. */
function matchBlocks(ref: StructuredDocument, got: StructuredDocument) {
  const browser = got.blocks.filter((b) => !CHROME_TYPES.has(b.type));
  const used = new Set<string>();
  const matches: {
    refId: string;
    gotId: string | null;
    similarity: number;
  }[] = [];
  for (const rb of contentBlocks(ref)) {
    let best: { id: string | null; sim: number } = { id: null, sim: 0 };
    for (const bb of browser) {
      if (used.has(bb.id)) continue;
      const sim = diceSimilarity(rb.text, bb.text);
      if (sim > best.sim) best = { id: bb.id, sim };
    }
    if (best.id !== null && best.sim >= MATCH_THRESHOLD) {
      used.add(best.id);
      matches.push({ refId: rb.id, gotId: best.id, similarity: best.sim });
    } else {
      matches.push({ refId: rb.id, gotId: null, similarity: best.sim });
    }
  }
  return matches;
}

async function evaluateFixture(entry: CorpusEntry): Promise<FixtureResult> {
  const ref = loadReference(entry);
  const got = await extractWithBrowserPipeline(
    assetPath(entry.pdf),
    `browser-${entry.id}`,
    `${entry.id}.pdf`,
  );

  const refContent = contentBlocks(ref);
  const matches = matchBlocks(ref, got);
  const byId = new Map(got.blocks.map((b) => [b.id, b]));

  const recovered = matches.filter((m) => m.gotId !== null);
  const missed = matches
    .filter((m) => m.gotId === null)
    .map((m) => {
      const rb = refContent.find((b) => b.id === m.refId);
      return { text: (rb?.text ?? "").slice(0, 60), type: rb?.type ?? "?" };
    });

  const typeStat = (type: string) => {
    const refOf = refContent.filter((b) => b.type === type);
    const recoveredRight = refOf.filter((rb) => {
      const m = matches.find((x) => x.refId === rb.id);
      return m?.gotId != null && byId.get(m.gotId)?.type === type;
    });
    return { reference: refOf.length, recovered: recoveredRight.length };
  };

  let pageSum = 0;
  let pageCount = 0;
  for (const m of recovered) {
    const rb = refContent.find((b) => b.id === m.refId);
    const bb = byId.get(m.gotId as string);
    if (rb && bb) {
      pageCount += 1;
      if (rb.page === bb.page) pageSum += 1;
    }
  }

  const order = recovered.map((m) => ({
    ref: refContent.find((b) => b.id === m.refId)!.order,
    got: byId.get(m.gotId as string)!.order,
  }));
  let monotonic = true;
  for (let i = 1; i < order.length; i++) {
    if (order[i].got < order[i - 1].got) monotonic = false;
  }

  const chromeRef = ref.blocks.filter((b) => CHROME_TYPES.has(b.type));
  const chromeGot = got.blocks.filter((b) => CHROME_TYPES.has(b.type));
  const chromeRecovered = chromeRef.filter((cb) =>
    chromeGot.some((gb) => normalizeText(gb.text) === normalizeText(cb.text)),
  );

  const provBlocks = got.blocks.length;
  const provOk = got.blocks.filter((b) => b.page >= 1 && b.bbox !== undefined).length;

  const refText = refContent.map((b) => b.text).join(" ");
  const gotText = browser2Text(got);

  const misclassified = recovered
    .map((m) => {
      const rb = refContent.find((b) => b.id === m.refId)!;
      const bb = byId.get(m.gotId as string)!;
      return rb.type !== bb.type
        ? { text: rb.text.slice(0, 60), expected: rb.type, got: bb.type }
        : null;
    })
    .filter((v): v is NonNullable<typeof v> => v !== null);

  return {
    fixtureId: entry.id,
    category: entry.category,
    referenceBlocks: refContent.length,
    browserBlocks: got.blocks.length,
    textFidelity: round(diceSimilarity(refText, gotText)),
    contentRecall: round(recovered.length / Math.max(1, refContent.length)),
    pageAccuracy: pageCount > 0 ? round(pageSum / pageCount) : null,
    readingOrderMonotonic: monotonic,
    headingDetection: typeStat("heading"),
    listDetection: typeStat("list-item"),
    footnoteDetection: typeStat("footnote"),
    tableCells: typeStat("table-cell"),
    chromeClassification: {
      reference: chromeRef.length,
      recovered: chromeRecovered.length,
    },
    provenanceCoverage: round(provOk / Math.max(1, provBlocks)),
    missed,
    misclassified,
  };
}

function browser2Text(doc: StructuredDocument): string {
  return contentBlocks(doc)
    .map((b) => b.text)
    .join(" ");
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

async function main(): Promise<void> {
  const manifest = loadManifest();
  const fixtures: FixtureResult[] = [];
  for (const entry of manifest.entries) {
    if (!entry.reference) continue;
    fixtures.push(await evaluateFixture(entry));
  }
  const result = {
    generatedAt: new Date().toISOString(),
    gate: "G2",
    question:
      "How much semantic structure survives browser extraction vs the reference export?",
    caveat:
      "Reference exports are synthetic Docling-shaped files produced by the fixture generator (upper bound of what a desktop parser should recover). Real-Docling benchmarking on legally-held PDFs is documented in evaluation/corpus/README.md.",
    fixtures,
    summary: {
      meanTextFidelity: round(
        fixtures.reduce((a, f) => a + f.textFidelity, 0) / Math.max(1, fixtures.length),
      ),
      meanContentRecall: round(
        fixtures.reduce((a, f) => a + f.contentRecall, 0) / Math.max(1, fixtures.length),
      ),
      readingOrderFailures: fixtures.filter((f) => !f.readingOrderMonotonic).length,
      tablesDetected: fixtures.reduce((a, f) => a + f.tableCells.recovered, 0),
      tablesPresent: fixtures.reduce((a, f) => a + f.tableCells.reference, 0),
    },
  };
  const path = writeResult("extraction.json", result);
  console.log(`[eval:extraction] wrote ${path}`);
  for (const f of fixtures) {
    console.log(
      `  ${f.fixtureId}: text=${f.textFidelity} recall=${f.contentRecall} ` +
        `headings=${f.headingDetection.recovered}/${f.headingDetection.reference} ` +
        `footnotes=${f.footnoteDetection.recovered}/${f.footnoteDetection.reference} ` +
        `order=${f.readingOrderMonotonic ? "ok" : "FAIL"}`,
    );
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
