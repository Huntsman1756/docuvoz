/**
 * Part 13 — Empty / trivial / whitespace document handling.
 *
 * Verifies that every adapter produces a clean, user-friendly error for
 * empty, whitespace-only, or trivially-small documents — never crashes.
 */
import { describe, expect, it } from "vitest";
import { htmlAdapter } from "@/adapters/document-parsers/adapters/html-adapter";
import { markdownAdapter } from "@/adapters/document-parsers/adapters/markdown-adapter";
import { txtAdapter } from "@/adapters/document-parsers/adapters/txt-adapter";
import { asFile, buildDocx, buildEpub } from "../e2e/helpers/doc-fixtures";
import { epubAdapter } from "@/adapters/document-parsers/adapters/epub-adapter";
import { docxAdapter } from "@/adapters/document-parsers/adapters/docx-adapter";

function expectEmptyError(result: Promise<unknown>) {
  return expect(result).rejects.toThrow(/no se ha encontrado texto legible/i);
}

describe("txtAdapter: empty / trivial / whitespace", () => {
  it("rejects truly empty files", async () => {
    const file = new File([new Uint8Array(0)], "empty.txt", { type: "text/plain" });
    await expectEmptyError(txtAdapter.load(file, { id: "e1", name: "empty.txt" }));
  });

  it("rejects whitespace-only files", async () => {
    for (const content of ["  ", "\n\n", "\r\n\r\n", "\t\t\t", " \n \r "]) {
      const file = new File([content], "ws.txt", { type: "text/plain" });
      await expectEmptyError(txtAdapter.load(file, { id: "e1", name: "ws.txt" }));
    }
  });

  it("accepts a single-word file", async () => {
    const file = new File(["Hello"], "single.txt", { type: "text/plain" });
    const doc = await txtAdapter.load(file, { id: "e2", name: "single.txt" });
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].text).toBe("Hello");
  });

  it("handles BOM-only files", async () => {
    const bom = new Uint8Array([0xef, 0xbb, 0xbf]);
    const file = new File([bom], "bom.txt", { type: "text/plain" });
    await expectEmptyError(txtAdapter.load(file, { id: "e3", name: "bom.txt" }));
  });
});

describe("htmlAdapter: empty / trivial / whitespace", () => {
  it("rejects empty HTML", async () => {
    const file = new File([""], "empty.html", { type: "text/html" });
    await expectEmptyError(htmlAdapter.load(file, { id: "e4", name: "empty.html" }));
  });

  it("rejects HTML with only whitespace", async () => {
    const file = new File(["  \n\n  "], "ws.html", { type: "text/html" });
    await expectEmptyError(htmlAdapter.load(file, { id: "e5", name: "ws.html" }));
  });

  it("rejects empty <body>", async () => {
    const file = new File(["<html><body></body></html>"], "empty-body.html", {
      type: "text/html",
    });
    await expectEmptyError(htmlAdapter.load(file, { id: "e6", name: "empty-body.html" }));
  });

  it("rejects HTML with only whitespace in body", async () => {
    const file = new File(["<html><body>   \n  </body></html>"], "ws-body.html", {
      type: "text/html",
    });
    await expectEmptyError(htmlAdapter.load(file, { id: "e7", name: "ws-body.html" }));
  });

  it("accepts a single word in HTML", async () => {
    const file = new File(["<html><body><p>Hello</p></body></html>"], "single.html", {
      type: "text/html",
    });
    const doc = await htmlAdapter.load(file, { id: "e8", name: "single.html" });
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].text).toBe("Hello");
  });
});

describe("markdownAdapter: empty / trivial / whitespace", () => {
  it("rejects empty markdown", async () => {
    const file = new File([""], "empty.md", { type: "text/markdown" });
    await expectEmptyError(markdownAdapter.load(file, { id: "e9", name: "empty.md" }));
  });

  it("rejects whitespace-only markdown", async () => {
    const file = new File(["  \n\n  "], "ws.md", { type: "text/markdown" });
    await expectEmptyError(markdownAdapter.load(file, { id: "e10", name: "ws.md" }));
  });

  it("rejects markdown with only horizontal rules", async () => {
    const file = new File(["---\n\n***\n\n___\n"], "hr-only.md", {
      type: "text/markdown",
    });
    await expectEmptyError(markdownAdapter.load(file, { id: "e11", name: "hr-only.md" }));
  });

  it("accepts a single word in markdown", async () => {
    const file = new File(["Hello"], "single.md", { type: "text/markdown" });
    const doc = await markdownAdapter.load(file, { id: "e12", name: "single.md" });
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].text).toBe("Hello");
  });
});

describe("docxAdapter: empty / trivial / whitespace", () => {
  it("rejects DOCX with only whitespace content", async () => {
    const docx = await buildDocx({
      items: [{ type: "para", text: "   " }],
    });
    await expectEmptyError(
      docxAdapter.load(asFile(docx), { id: "e13", name: "ws.docx" }),
    );
  });

  it("rejects a malformed DOCX (not ZIP)", async () => {
    const file = new File(
      [new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05])],
      "not-zip.docx",
      {
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      },
    );
    await expect(
      docxAdapter.load(file, { id: "e14", name: "not-zip.docx" }),
    ).rejects.toThrow();
  });

  it("accepts a DOCX with one paragraph", async () => {
    const docx = await buildDocx({
      items: [{ type: "para", text: "Single paragraph." }],
    });
    const doc = await docxAdapter.load(asFile(docx), { id: "e15", name: "single.docx" });
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].text).toBe("Single paragraph.");
  });
});

describe("epubAdapter: empty / trivial / whitespace", () => {
  it("rejects EPUB with only whitespace content", async () => {
    // Minimal EPUB with a single whitespace-only body and no TOC
    const emptyChap = await buildEpub({
      name: "empty.epub",
      title: "Empty",
      language: "es",
      version: 3,
      toc: null,
      chapters: [
        {
          file: "chap1.xhtml",
          title: "Empty",
          body: `<div>   </div>`,
        },
      ],
    });
    await expectEmptyError(
      epubAdapter.load(asFile(emptyChap), { id: "e16", name: "empty.epub" }),
    );
  });

  it("rejects non-ZIP data as EPUB", async () => {
    const file = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], "not-zip.epub", {
      type: "application/epub+zip",
    });
    await expect(
      epubAdapter.load(file, { id: "e17", name: "not-zip.epub" }),
    ).rejects.toThrow();
  });

  it("accepts an EPUB with one word", async () => {
    const tiny = await buildEpub({
      name: "tiny.epub",
      title: "Tiny",
      language: "es",
      version: 3,
      toc: null,
      chapters: [
        {
          file: "chap1.xhtml",
          title: "Tiny",
          body: `<div>One word.</div>`,
        },
      ],
    });
    const doc = await epubAdapter.load(asFile(tiny), { id: "e18", name: "tiny.epub" });
    expect(doc.blocks.length).toBeGreaterThan(0);
  });
});
