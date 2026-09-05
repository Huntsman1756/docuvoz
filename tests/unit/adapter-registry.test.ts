/**
 * Tests for document format detection and adapter registry.
 */
import { describe, it, expect } from "vitest";
import {
  detectFormat,
  getAdapter,
  type DocumentFormat,
} from "@/adapters/document-parsers/document-adapter";
import "@/adapters/document-parsers/adapter-registry"; // side-effect: registers all adapters

describe("detectFormat", () => {
  const cases: Array<{
    name: string;
    file: Partial<File>;
    head?: Uint8Array;
    expected: DocumentFormat | null;
  }> = [
    {
      name: "PDF by extension",
      file: { name: "report.pdf", type: "application/pdf" },
      expected: "pdf",
    },
    {
      name: "EPUB by extension",
      file: { name: "book.epub", type: "application/epub+zip" },
      expected: "epub",
    },
    {
      name: "DOCX by extension",
      file: {
        name: "doc.docx",
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
      expected: "docx",
    },
    {
      name: "TXT by extension",
      file: { name: "notes.txt", type: "text/plain" },
      expected: "txt",
    },
    {
      name: "Markdown by extension .md",
      file: { name: "readme.md", type: "" },
      expected: "markdown",
    },
    {
      name: "Markdown by extension .markdown",
      file: { name: "doc.markdown", type: "" },
      expected: "markdown",
    },
    {
      name: "HTML by extension .html",
      file: { name: "page.html", type: "text/html" },
      expected: "html",
    },
    {
      name: "HTML by extension .htm",
      file: { name: "page.htm", type: "" },
      expected: "html",
    },
    {
      name: "PDF by MIME type",
      file: { name: "unknown", type: "application/pdf" },
      expected: "pdf",
    },
    {
      name: "PDF by magic bytes",
      file: { name: "noext", type: "" },
      head: new Uint8Array([0x25, 0x50, 0x44, 0x46]),
      expected: "pdf",
    },
    {
      name: "Unknown format returns null",
      file: { name: "image.png", type: "image/png" },
      expected: null,
    },
    {
      name: "Empty name returns null",
      file: { name: "", type: "" },
      expected: null,
    },
  ];

  for (const tc of cases) {
    it(tc.name, async () => {
      const file = new File([""], tc.file.name ?? "", { type: tc.file.type ?? "" });
      const result = await detectFormat(file, tc.head);
      expect(result).toBe(tc.expected);
    });
  }
});

describe("adapter registry", () => {
  const formats: DocumentFormat[] = ["pdf", "epub", "docx", "txt", "markdown", "html"];

  for (const fmt of formats) {
    it(`has adapter for ${fmt}`, () => {
      const adapter = getAdapter(fmt);
      expect(adapter).toBeDefined();
      expect(adapter!.formats).toContain(fmt);
    });
  }

  it("each adapter has canOpen method", () => {
    for (const fmt of formats) {
      const adapter = getAdapter(fmt)!;
      expect(typeof adapter.canOpen).toBe("function");
    }
  });

  it("each adapter has load method", () => {
    for (const fmt of formats) {
      const adapter = getAdapter(fmt)!;
      expect(typeof adapter.load).toBe("function");
    }
  });
});
