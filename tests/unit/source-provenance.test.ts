/**
 * Part 8 — source provenance. The UI does not show these fields, but they
 * must survive into the canonical document so rendered text can always be
 * mapped back to the extracted source.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { txtAdapter } from "@/adapters/document-parsers/adapters/txt-adapter";
import { markdownAdapter } from "@/adapters/document-parsers/adapters/markdown-adapter";
import { htmlAdapter } from "@/adapters/document-parsers/adapters/html-adapter";
import { docxAdapter } from "@/adapters/document-parsers/adapters/docx-adapter";
import { epubAdapter } from "@/adapters/document-parsers/adapters/epub-adapter";
import { buildDocument } from "@/adapters/document-parsers/build-document";
import type { RawPdfPage } from "@/adapters/document-parsers/build-document";
import {
  asFile,
  buildSampleEpub,
  buildSampleDocx,
  SAMPLE_TXT,
  SAMPLE_MARKDOWN,
  SAMPLE_HTML,
  SAMPLE_EPUB_MARKERS as ME,
} from "../e2e/helpers/doc-fixtures";

describe("TXT provenance (line ranges)", () => {
  it("each paragraph block maps to its source L<start>-L<end> range", async () => {
    const file = new File([SAMPLE_TXT], "t.txt", { type: "text/plain" });
    const doc = await txtAdapter.load(file, { id: "p-txt", name: "t.txt" });
    const lines = SAMPLE_TXT.replace(/^\uFEFF/, "").split("\n");
    expect(doc.blocks.length).toBe(3);
    for (const b of doc.blocks) {
      expect(b.sourceRef).toMatch(/^L\d+-L\d+$/);
      const [, s, e] = /L(\d+)-L(\d+)/.exec(b.sourceRef!)!;
      const slice = lines.slice(Number(s) - 1, Number(e)).join(" ");
      // The first sentence of the block must exist inside the recorded range.
      const needle = b.text.split(" ").slice(0, 4).join(" ");
      expect(slice.includes(needle), `${b.sourceRef} does not contain "${needle}"`).toBe(
        true,
      );
    }
    // BOM must not break the first range
    expect(doc.blocks[0].sourceRef).toBe("L1-L1");
  });
});

describe("Markdown provenance (parser token line map)", () => {
  it("blocks carry token-derived line ranges that match the source", async () => {
    const doc = await markdownAdapter.load(new File([SAMPLE_MARKDOWN], "t.md"), {
      id: "p-md",
      name: "t.md",
    });
    const lines = SAMPLE_MARKDOWN.split("\n");
    const speakable = doc.blocks.filter((b) => b.type !== "separator");
    expect(speakable.length).toBeGreaterThan(4);
    // Spoken text drops Markdown punctuation, so compare alphanumerically-normalised
    // prefixes: a spoken block's opening words must appear inside its source lines.
    const norm = (s: string) => s.replace(/[^0-9a-záéíóúüñ]/gi, "").toLowerCase();
    for (const b of speakable) {
      expect(b.sourceRef, `missing line range on "${b.text.slice(0, 20)}"`).toMatch(
        /^L\d+-L\d+$/,
      );
      const [, s, e] = /L(\d+)-L(\d+)/.exec(b.sourceRef!)!;
      const slice = norm(lines.slice(Number(s) - 1, Number(e)).join(" "));
      const needle = norm(b.text).slice(0, 24);
      expect(slice.length).toBeGreaterThan(0);
      if (needle.length > 0) {
        expect(slice.includes(needle), `${b.sourceRef} vs "${b.text.slice(0, 20)}"`).toBe(
          true,
        );
      }
    }
  });

  it("syntax characters never leak into speakable text", async () => {
    const doc = await markdownAdapter.load(new File([SAMPLE_MARKDOWN], "t.md"), {
      id: "p-md2",
      name: "t.md",
    });
    const all = doc.blocks.map((b) => b.text).join("\n");
    expect(all).not.toContain("##");
    expect(all).not.toContain("**");
    expect(all).not.toContain(">");
    expect(all).not.toContain("](https://");
    // the link TEXT is preserved though
    expect(all).toContain("página del proyecto");
  });
});

describe("HTML provenance (deterministic DOM path identity)", () => {
  async function load() {
    return htmlAdapter.load(new File([SAMPLE_HTML], "t.html", { type: "text/html" }), {
      id: "p-html",
      name: "t.html",
    });
  }
  it("blocks carry html: DOM paths, unique and stable across loads", async () => {
    const a = await load();
    const b = await load();
    for (const blk of a.blocks) {
      expect(blk.sourceRef).toMatch(/^html:/);
    }
    expect(new Set(a.blocks.map((x) => x.sourceRef)).size).toBe(a.blocks.length);
    expect(a.blocks.map((x) => x.sourceRef)).toEqual(b.blocks.map((x) => x.sourceRef));
  });
});

describe("DOCX provenance (semantic block identity path)", () => {
  it("docx: paths are unique, stable and reflect nesting", async () => {
    const one = await buildSampleDocx();
    const a = await docxAdapter.load(asFile(one), { id: "p-docx", name: "s.docx" });
    const b = await docxAdapter.load(asFile(await buildSampleDocx()), {
      id: "p-docx",
      name: "s.docx",
    });
    expect(a.blocks.map((x) => x.sourceRef)).toEqual(b.blocks.map((x) => x.sourceRef));
    for (const blk of a.blocks) {
      expect(blk.sourceRef).toMatch(/^docx:body>/);
    }
    // nested list item path shows nesting
    const nested = a.blocks.find((x) => x.text === "compatible con lectores de pantalla");
    expect(nested?.sourceRef).toMatch(/>li\[\d+\]>ul\[\d+\]>li\[\d+\]$/);
    // table cells carry indexed paths with header markers
    expect(a.blocks.some((x) => x.sourceRef?.includes(">cell["))).toBe(true);
  });
});

describe("EPUB provenance (spine index, stable ref, CFI)", () => {
  it("blocks retain spine section index, path#pN reference and CFI", async () => {
    const doc = await epubAdapter.load(asFile(await buildSampleEpub()), {
      id: "p-epub",
      name: "s.epub",
    });
    const chap1 = doc.blocks.find((b) => b.text.includes(ME.chap1Text));
    const chap2 = doc.blocks.find((b) => b.text.includes(ME.chap2Text));
    expect(chap1?.sectionIndex).toBe(0);
    expect(chap2?.sectionIndex).toBe(1);
    expect(chap1?.sourceRef).toBe("OEBPS/chap1.xhtml#p1");
    expect(chap1?.sourceCfi).toBe("epubcfi(/6/2)");
    expect(chap2?.sourceCfi).toBe("epubcfi(/6/4)");
    for (const blk of doc.blocks) {
      expect(blk.sourceRef).toMatch(/^OEBPS\/[\w.]+\.xhtml#p\d+$/);
      expect(blk.sourceCfi).toMatch(/^epubcfi\(\/6\/\d+\)$/);
    }
  });
});

describe("PDF provenance (no regression on page/segment)", () => {
  it("blocks keep 1-based page and bbox segment coordinates", () => {
    const pages: RawPdfPage[] = [
      {
        page: 1,
        width: 595,
        height: 842,
        items: [
          {
            str: "Título principal del documento de prueba",
            x: 70,
            yTop: 80,
            width: 300,
            height: 18,
          },
          {
            str: "Párrafo de cuerpo normal para la prueba.",
            x: 70,
            yTop: 120,
            width: 400,
            height: 11,
          },
        ],
      },
      {
        page: 2,
        width: 595,
        height: 842,
        items: [
          {
            str: "Segunda página con su contenido.",
            x: 70,
            yTop: 120,
            width: 400,
            height: 11,
          },
          { str: "7", x: 295, yTop: 800, width: 8, height: 9 },
        ],
      },
    ];
    const doc = buildDocument(pages, { id: "p-pdf", name: "t.pdf" });
    expect(doc.blocks.every((b) => Number.isInteger(b.page) && b.page >= 1)).toBe(true);
    expect(doc.blocks.every((b) => b.bbox && b.bbox.length === 4)).toBe(true);
    const heading = doc.blocks.find((b) => b.type === "heading");
    expect(heading?.page).toBe(1);
    const pageNumber = doc.blocks.find((b) => b.type === "page-number");
    expect(pageNumber?.page).toBe(2);
  });

  it("real corpus PDF retains per-page provenance through buildDocument", async () => {
    const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const data = new Uint8Array(
      readFileSync(join("public", "corpus", "pdfs", "simple-01.pdf")),
    );
    const pdf = await pdfjs.getDocument({ data }).promise;
    try {
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
            .filter((i) => "str" in i && i.str.trim().length > 0)
            .map((i) => {
              const it = i as {
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
      const doc = buildDocument(pages, { id: "p-pdf-real", name: "simple-01.pdf" });
      const pageCount = doc.source.pageCount;
      expect(pageCount).toBeGreaterThanOrEqual(2);
      const pagesSeen = new Set(doc.blocks.map((b) => b.page));
      expect(pagesSeen.size).toBe(pageCount);
      expect(doc.blocks.every((b) => b.bbox != null)).toBe(true);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
});
