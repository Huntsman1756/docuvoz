/**
 * Part 7 — canonical-model contract, shared by every format adapter.
 *
 * Every format must converge on exactly one pipeline:
 *   source file → DocumentAdapter → StructuredDocument → speech planning → BufferedSpeechPlayer
 *
 * These invariants are asserted against the SAME code paths the Reader uses
 * (the real adapters; PDF via the same pdf.js-legacy + buildDocument chain
 * the browser adapter wraps, byte-for-byte from a real corpus PDF).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { StructuredDocument } from "@/domain/documents/types";
import type {
  DocumentAdapter,
  LoadOptions,
} from "@/adapters/document-parsers/document-adapter";
import { pdfAdapter } from "@/adapters/document-parsers/adapters/pdf-adapter";
import { epubAdapter } from "@/adapters/document-parsers/adapters/epub-adapter";
import { docxAdapter } from "@/adapters/document-parsers/adapters/docx-adapter";
import { txtAdapter } from "@/adapters/document-parsers/adapters/txt-adapter";
import { markdownAdapter } from "@/adapters/document-parsers/adapters/markdown-adapter";
import { htmlAdapter } from "@/adapters/document-parsers/adapters/html-adapter";
import {
  buildDocument,
  type RawPdfPage,
} from "@/adapters/document-parsers/build-document";
import { buildSpokenPlan } from "@/domain/spoken/pipeline";
import { planChunks } from "@/domain/spoken/speech-plan";
import {
  asFile,
  buildSampleEpub,
  buildSampleDocx,
  SAMPLE_TXT,
  SAMPLE_MARKDOWN,
  SAMPLE_HTML,
} from "../e2e/helpers/doc-fixtures";

type Pdfjs = typeof import("pdfjs-dist/legacy/build/pdf.mjs");
let pdfjs: Pdfjs;

beforeAll(async () => {
  pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
});

function options(id: string, name: string, language = "es"): LoadOptions {
  return { id, name, language };
}

async function loadRealPdf(name: string): Promise<StructuredDocument> {
  // Same pipeline as the browser adapter (pdfjs legacy text items → buildDocument),
  // from real corpus bytes. pdf-adapter itself only adds hashing + delegation,
  // and its abort contract is checked against the adapter below.
  const data = new Uint8Array(readFileSync(join("public", "corpus", "pdfs", name)));
  const pdf = await pdfjs.getDocument({
    data,
    standardFontDataUrl:
      join(process.cwd(), "node_modules", "pdfjs-dist", "standard_fonts", "") + "/",
  }).promise;
  const pages: RawPdfPage[] = [];
  try {
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
  } finally {
    await pdf.loadingTask.destroy();
  }
  return buildDocument(pages, { id: "contract-pdf", name, language: "es" });
}

interface ContractSubject {
  format: string;
  adapter: DocumentAdapter;
  makeFile: () => Promise<File>;
  load: () => Promise<StructuredDocument>;
  /** Does the adapter carry per-block sourceRef provenance? */
  sourceRefRequired: boolean;
}

const subjects: ContractSubject[] = [
  {
    format: "pdf",
    adapter: pdfAdapter,
    makeFile: async () =>
      new File(
        [readFileSync(join("public", "corpus", "pdfs", "simple-01.pdf"))],
        "simple-01.pdf",
        { type: "application/pdf" },
      ),
    load: () => loadRealPdf("simple-01.pdf"),
    sourceRefRequired: false, // PDF proves provenance via page + bbox
  },
  {
    format: "epub",
    adapter: epubAdapter,
    makeFile: async () => asFile(await buildSampleEpub()),
    load: async () =>
      epubAdapter.load(
        asFile(await buildSampleEpub()),
        options("contract-epub", "s.epub"),
      ),
    sourceRefRequired: true,
  },
  {
    format: "docx",
    adapter: docxAdapter,
    makeFile: async () => asFile(await buildSampleDocx()),
    load: async () =>
      docxAdapter.load(
        asFile(await buildSampleDocx()),
        options("contract-docx", "s.docx"),
      ),
    sourceRefRequired: true,
  },
  {
    format: "txt",
    adapter: txtAdapter,
    makeFile: async () => new File([SAMPLE_TXT], "s.txt", { type: "text/plain" }),
    load: async () =>
      txtAdapter.load(new File([SAMPLE_TXT], "s.txt"), options("contract-txt", "s.txt")),
    sourceRefRequired: true,
  },
  {
    format: "markdown",
    adapter: markdownAdapter,
    makeFile: async () => new File([SAMPLE_MARKDOWN], "s.md", { type: "text/markdown" }),
    load: async () =>
      markdownAdapter.load(
        new File([SAMPLE_MARKDOWN], "s.md"),
        options("contract-md", "s.md"),
      ),
    sourceRefRequired: true,
  },
  {
    format: "html",
    adapter: htmlAdapter,
    makeFile: async () => new File([SAMPLE_HTML], "s.html", { type: "text/html" }),
    load: async () =>
      htmlAdapter.load(
        new File([SAMPLE_HTML], "s.html"),
        options("contract-html", "s.html"),
      ),
    sourceRefRequired: true,
  },
];

describe("canonical model contract (shared across adapters)", () => {
  for (const subject of subjects) {
    describe(subject.format, () => {
      let doc: StructuredDocument;
      beforeAll(async () => {
        doc = await subject.load();
      });

      it("produces a non-empty canonical document", () => {
        expect(doc.blocks.length).toBeGreaterThan(0);
        expect(doc.id).toBeTruthy();
        expect(doc.parser).toBeTruthy();
        expect(doc.parserVersion).toBeTruthy();
        expect(doc.source.name).toBeTruthy();
        expect(doc.source.language).toBeTruthy();
      });

      it("adapter declares the format and can open the real file", async () => {
        expect(subject.adapter.formats).toContain(subject.format as never);
        const file = await subject.makeFile();
        expect(subject.adapter.canOpen(file)).toBe(true);
      });

      it("block ids are sequential b0..bn and orders strictly increase", () => {
        doc.blocks.forEach((b, i) => {
          expect(b.id).toBe(`b${i}`);
          if (i > 0) expect(doc.blocks[i].order).toBeGreaterThan(doc.blocks[i - 1].order);
        });
      });

      it("sections/pages never go backwards (source order)", () => {
        for (let i = 1; i < doc.blocks.length; i++) {
          expect(doc.blocks[i].page).toBeGreaterThanOrEqual(doc.blocks[i - 1].page);
        }
        const withSection = doc.blocks.filter((b) => b.sectionIndex != null);
        for (let i = 1; i < withSection.length; i++) {
          expect(withSection[i].sectionIndex!).toBeGreaterThanOrEqual(
            withSection[i - 1].sectionIndex!,
          );
        }
      });

      it("no empty bogus blocks (only separators may be textless)", () => {
        for (const b of doc.blocks) {
          if (b.type === "separator") continue;
          expect(
            b.text.trim().length,
            `block ${b.id} (${b.type}) is empty`,
          ).toBeGreaterThan(0);
        }
      });

      it("every speakable block carries source provenance", () => {
        for (const b of doc.blocks) {
          if (subject.sourceRefRequired) {
            expect(b.sourceRef, `block ${b.id} lacks sourceRef`).toBeTruthy();
          } else {
            // PDF: provenance = 1-based page + bbox
            expect(Number.isInteger(b.page) && b.page >= 1).toBe(true);
            expect(b.bbox, `pdf block ${b.id} lacks bbox`).toBeDefined();
          }
        }
      });

      it("language is preserved when the format carries it", () => {
        expect(doc.source.language).toBe("es");
      });

      it("converges on the shared speech pipeline (plan → chunks)", () => {
        const plan = buildSpokenPlan(doc, "listen");
        expect(plan.segments.length).toBeGreaterThan(0);
        const chunks = planChunks(plan, 400, 200);
        expect(chunks.length).toBeGreaterThan(0);
        // provenance survives planning: every segment maps to real block ids
        const blockIds = new Set(doc.blocks.map((b) => b.id));
        for (const seg of plan.segments) {
          for (const id of seg.provenance.blockIds) {
            expect(blockIds.has(id), `segment refers to unknown block ${id}`).toBe(true);
          }
        }
      });

      it("stable document fingerprint: two loads of identical bytes agree structurally", async () => {
        const again = await subject.load();
        expect(again.blocks.map((b) => `${b.type}:${b.order}:${b.text}`)).toEqual(
          doc.blocks.map((b) => `${b.type}:${b.order}:${b.text}`),
        );
        expect(again.source.name).toBe(doc.source.name);
      });

      it("supports cancellation via AbortSignal (pre-aborted)", async () => {
        const controller = new AbortController();
        controller.abort();
        const file = await subject.makeFile();
        await expect(
          subject.adapter.load(
            file,
            options("cancel-" + subject.format, "x"),
            controller.signal,
          ),
        ).rejects.toThrow(/abort|cancel/i);
      });

      it("load is disposable: sequential loads stay clean", async () => {
        const a = await subject.load();
        const b = await subject.load();
        expect(a.blocks.length).toBe(b.blocks.length);
      });
    });
  }
});
