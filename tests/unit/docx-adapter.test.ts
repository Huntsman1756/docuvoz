/**
 * Tests for DOCX document adapter.
 *
 * Uses a minimal programmatically-generated DOCX (ZIP with XML content)
 * to test the extraction pipeline without copyrighted fixtures.
 */
import { describe, it, expect } from "vitest";
import JSZip from "jszip";
import { docxAdapter } from "@/adapters/document-parsers/adapters/docx-adapter";

/**
 * Create a minimal valid DOCX file with the given HTML-like paragraph content.
 * This generates the minimal XML structure needed by mammoth.
 */
async function createMinimalDocx(paragraphs: string[]): Promise<File> {
  const zip = new JSZip();

  // [Content_Types].xml
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`,
  );

  // _rels/.rels
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
  );

  // word/_rels/document.xml.rels
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`,
  );

  // word/document.xml with paragraphs
  const wParagraphs = paragraphs
    .map((p) => `<w:p><w:r><w:t>${escapeXml(p)}</w:t></w:r></w:p>`)
    .join("\n      ");

  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
      ${wParagraphs}
    <w:sectPr/>
  </w:body>
</w:document>`,
  );

  const blob = await zip.generateAsync({ type: "blob" });
  return new File([blob], "test.docx", {
    type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

describe("docxAdapter", () => {
  it("has correct id", () => {
    expect(docxAdapter.id).toBe("mammoth-docx");
  });

  it("supports .docx extension", () => {
    expect(docxAdapter.extensions).toContain(".docx");
  });

  it("canOpen returns true for .docx files", () => {
    const file = new File([""], "doc.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    expect(docxAdapter.canOpen(file)).toBe(true);
  });

  it("extracts paragraphs from simple DOCX", async () => {
    const file = await createMinimalDocx(["First paragraph.", "Second paragraph."]);
    const doc = await docxAdapter.load(file, {
      id: "test-docx-1",
      name: "test.docx",
    });

    expect(doc.parser).toBe("mammoth-docx");
    expect(doc.blocks.length).toBeGreaterThanOrEqual(2);
    const texts = doc.blocks.map((b) => b.text);
    expect(texts.some((t) => t.includes("First paragraph."))).toBe(true);
    expect(texts.some((t) => t.includes("Second paragraph."))).toBe(true);
  });

  it("all blocks are paragraphs (simple content)", async () => {
    const file = await createMinimalDocx(["Hello", "World"]);
    const doc = await docxAdapter.load(file, {
      id: "test-docx-types",
      name: "test.docx",
    });

    // Simple content should produce paragraph blocks
    for (const block of doc.blocks) {
      expect(["paragraph", "unknown"]).toContain(block.type);
    }
  });

  it("sets correct reading order", async () => {
    const file = await createMinimalDocx(["Alpha", "Beta", "Gamma"]);
    const doc = await docxAdapter.load(file, {
      id: "test-docx-order",
      name: "test.docx",
    });

    for (let i = 0; i < doc.blocks.length; i++) {
      expect(doc.blocks[i].order).toBe(i);
    }
  });

  it("produces valid document structure", async () => {
    const file = await createMinimalDocx(["Test content"]);
    const doc = await docxAdapter.load(file, {
      id: "test-docx-struct",
      name: "test.docx",
    });

    expect(doc.id).toBe("test-docx-struct");
    expect(doc.source.name).toBe("test.docx");
    expect(doc.source.language).toBeDefined();
    expect(doc.parserVersion).toBeDefined();
  });
});
