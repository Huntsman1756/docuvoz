/**
 * Integration: real PDF bytes through the real pdf.js (legacy build in
 * Node) into the same extraction pipeline the browser uses. CI-safe: no
 * network.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { RawPdfPage } from "@/adapters/document-parsers/build-document";
import { buildDocument } from "@/adapters/document-parsers/build-document";

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Pdfjs;

async function extractPages(file: string): Promise<RawPdfPage[]> {
  const data = new Uint8Array(readFileSync(file));
  const pdf = await pdfjs.getDocument({
    data,
    standardFontDataUrl:
      join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts", "") + "/",
  }).promise;
  const pages: RawPdfPage[] = [];
  for (let n = 1; n <= pdf.numPages; n++) {
    const page = await pdf.getPage(n);
    const content = await page.getTextContent();
    const view = page.view;
    pages.push({
      page: n,
      width: view[2] - view[0],
      height: view[3] - view[1],
      items: content.items
        .filter((item) => "str" in item && item.str.trim().length > 0)
        .map((item) => {
          const it = item as {
            str: string;
            transform: number[];
            width: number;
            height: number;
          };
          return {
            str: it.str,
            x: it.transform[4],
            yTop: view[3] - it.transform[5],
            width: it.width,
            height: it.height > 0 ? it.height : Math.abs(it.transform[3]),
          };
        }),
    });
  }
  await pdf.loadingTask.destroy();
  return pages;
}

beforeAll(async () => {
  pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
}, 60_000);

describe("browser extraction pipeline over synthetic PDFs", () => {
  it("extracts a nested regulation fixture with usable structure", async () => {
    const pages = await extractPages(
      join(process.cwd(), "public", "corpus", "pdfs", "nested-regulation-01.pdf"),
    );
    expect(pages).toHaveLength(3);
    const doc = buildDocument(pages, {
      id: "it-nested",
      name: "nested-regulation-01.pdf",
    });
    // Accents survive the PDF round trip.
    const body = doc.blocks.find((b) => b.text.includes("solvencia"));
    expect(body?.text).toContain("exentas");
    // Repeated headers/footers are classified.
    const headers = doc.blocks.filter((b) => b.type === "page-header");
    const footers = doc.blocks.filter(
      (b) => b.type === "page-footer" || b.type === "page-number",
    );
    expect(headers.length).toBeGreaterThanOrEqual(3);
    expect(footers.length).toBeGreaterThanOrEqual(3);
    // Headings detected by size.
    const headings = doc.blocks.filter((b) => b.type === "heading");
    expect(headings.some((h) => h.text.includes("OBJETO"))).toBe(true);
    // Provenance: every block carries page + bbox.
    for (const block of doc.blocks) {
      expect(block.page).toBeGreaterThanOrEqual(1);
      expect(block.bbox).toBeDefined();
    }
  });

  it("listen mode mutes fixture chrome and normalizes citations", async () => {
    const { buildSpokenPlan } = await import("@/domain/spoken/pipeline");
    const pages = await extractPages(
      join(process.cwd(), "public", "corpus", "pdfs", "nested-regulation-01.pdf"),
    );
    const doc = buildDocument(pages, { id: "it-nested-2", name: "x.pdf" });
    const plan = buildSpokenPlan(doc, "listen");
    expect(plan.stats.mutedNoise).toBeGreaterThanOrEqual(3);
    const cited = plan.segments.find((s) => s.sourceText.includes("57.1.b)"));
    expect(cited).toBeDefined();
    expect(cited?.text).toContain("artículo cincuenta y siete, apartado uno, letra be");
    expect(cited?.fidelityOk).toBe(true);
    const amount = plan.segments.find((s) => s.sourceText.includes("1.234.567,89"));
    expect(amount?.text).toContain(
      "un millón doscientos treinta y cuatro mil quinientos sesenta y siete euros con ochenta y nueve céntimos",
    );
    expect(plan.stats.rejected).toBe(0);
  });

  it("simple fixture keeps reading order across pages", async () => {
    const pages = await extractPages(
      join(process.cwd(), "public", "corpus", "pdfs", "simple-01.pdf"),
    );
    const doc = buildDocument(pages, { id: "it-simple", name: "x.pdf" });
    const body = doc.blocks.filter((b) => b.type === "paragraph");
    expect(body[0]?.text).toContain("nota es un documento de prueba");
    expect(body[body.length - 1]?.page).toBe(2);
    expect(doc.blocks.map((b) => b.order)).toEqual(doc.blocks.map((_, i) => i));
  });
});
