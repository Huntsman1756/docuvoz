/**
 * Part 12 — DOCX edge cases. Semantics follow upstream Mammoth behaviour:
 * the adapter neither emulates Word nor hides Mammoth's significant messages.
 */
import { describe, expect, it, beforeEach } from "vitest";
import JSZip from "jszip";
import { docxAdapter } from "@/adapters/document-parsers/adapters/docx-adapter";
import { getParserDiagnostics, clearParserDiagnostics } from "@/lib/diagnostics";
import {
  asFile,
  buildDocx,
  buildSampleDocx,
  SAMPLE_DOCX_MARKERS as M,
} from "../e2e/helpers/doc-fixtures";

beforeEach(() => clearParserDiagnostics());

async function loadDocx(name: string, buffer: Buffer) {
  return docxAdapter.load(
    asFile({
      name,
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer,
    }),
    { id: "docx-edge", name },
  );
}

describe("DOCX edge cases", () => {
  it("extracts the full sample semantic structure", async () => {
    const doc = await loadDocx("s.docx", (await buildSampleDocx()).buffer);
    const byType = (t: string) => doc.blocks.filter((b) => b.type === t);

    // Title + Heading 2s with correct levels
    const h1 = doc.blocks.find((b) => b.type === "heading" && b.level === 1);
    expect(h1?.text).toBe(M.title);
    const h2s = byType("heading")
      .filter((b) => b.level === 2)
      .map((b) => b.text);
    expect(h2s).toContain(M.h2);
    expect(h2s).toContain(M.listBulletHeading);
    expect(h2s).toContain(M.listOrderedHeading);
    expect(h2s).toContain(M.tableHeading);

    // Paragraphs ordered
    const texts = doc.blocks.map((b) => b.text);
    expect(texts.indexOf(M.para1)).toBeGreaterThan(-1);

    // Bullet list with nested item at depth 1
    const bullets = doc.blocks.filter((b) => b.type === "list-item" && b.listLevel === 0);
    expect(bullets.some((b) => b.text === M.bullet1)).toBe(true);
    expect(bullets.some((b) => b.text === M.numbered1)).toBe(true);
    const nested = doc.blocks.find((b) => b.text === M.nested);
    expect(nested?.listLevel).toBe(1);

    // Table cells present with header flag in sourceRef
    const cells = byType("table-cell").map((b) => b.text);
    expect(cells).toContain(M.tableHeader1);
    expect(cells).toContain(M.tableCell2);
    expect(
      doc.blocks.some((b) => b.type === "table-cell" && b.sourceRef?.includes("#h")),
    ).toBe(true);

    // Hyperlink text survives; raw URL does not enter spoken text
    const linkBlock = doc.blocks.find((b) => b.text.includes(M.linkText));
    expect(linkBlock?.text).toContain(M.linkBefore);
    expect(linkBlock?.text).not.toContain("example.invalid");

    // Footnote content surfaces (Mammoth inlines it after the body)
    expect(texts.some((t) => t.includes(M.footnoteText))).toBe(true);

    // Image accessible description
    expect(texts.some((t) => t.includes(`[Imagen: ${M.imageAlt}]`))).toBe(true);

    // Text box content reaches the reader (via mc:Fallback)
    expect(texts.some((t) => t.includes(M.textboxText))).toBe(true);

    // TOC built from headings
    expect(doc.toc && doc.toc.length).toBeGreaterThanOrEqual(5);
  });

  it("nested lists preserve hierarchy", async () => {
    const docx = await buildDocx({
      items: [
        {
          type: "list",
          ordered: false,
          items: [{ text: "nivel 1", children: { ordered: false, items: ["nivel 2"] } }],
        },
      ],
    });
    const d = await loadDocx("n.docx", docx.buffer);
    const l0 = d.blocks.find((b) => b.text === "nivel 1");
    const l1 = d.blocks.find((b) => b.text === "nivel 2");
    expect(l0?.listLevel).toBe(0);
    expect(l1?.listLevel).toBe(1);
  });

  it("external hyperlink relationship does not create network access", async () => {
    const docx = await buildDocx({
      items: [
        {
          type: "link",
          before: "ver ",
          text: "sitio externo",
          url: "https://evil.invalid/x",
          after: " ahora",
        },
      ],
    });
    const d = await loadDocx("ext.docx", docx.buffer);
    const text = d.blocks.map((b) => b.text).join(" ");
    expect(text).toContain("sitio externo");
    expect(text).not.toContain("evil.invalid");
  });

  it("image referenced via EXTERNAL relationship never becomes a remote reference", async () => {
    // Mammoth with externalFileAccess:false must not fetch nor emit http(s) src.
    const base = await buildDocx({
      items: [{ type: "para", text: "antes y despues del recurso externo." }],
    });
    // Rebuild with an external-target image relationship (mammoth ignores it).
    const reopened = await JSZip.loadAsync(base.buffer);
    const rels = (
      await reopened.file("word/_rels/document.xml.rels")!.async("text")
    ).replace(
      "</Relationships>",
      '<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://evil.invalid/imagen.png" TargetMode="External"/></Relationships>',
    );
    reopened.file("word/_rels/document.xml.rels", rels);
    reopened.file(
      "word/document.xml",
      (await reopened.file("word/document.xml")!.async("text")).replace(
        "<w:sectPr/>",
        `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:docPr id="7" name="remota" descr="imagen remota"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="7" name="remota" descr="imagen remota"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdX"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:sectPr/>`,
      ),
    );
    const tampered = await reopened.generateAsync({ type: "nodebuffer" });
    const d = await loadDocx("extimg.docx", tampered);
    for (const b of d.blocks) {
      expect(b.text).not.toMatch(/https?:\/\//);
    }
    // The document still opens with its text intact.
    expect(d.blocks.map((b) => b.text).join(" ")).toContain("recurso externo");
  });

  it("malformed DOCX (not a zip) is rejected with an error, not a crash", async () => {
    const file = asFile({
      name: "roto.docx",
      mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      buffer: Buffer.from("esto no es un zip ni un docx".repeat(40)),
    });
    await expect(
      docxAdapter.load(file, { id: "roto", name: "roto.docx" }),
    ).rejects.toThrow();
  });

  it("DOCX without readable text reports a clear Spanish error", async () => {
    const docx = await buildDocx({ items: [{ type: "para", text: "   " }] });
    await expect(loadDocx("vacio.docx", docx.buffer)).rejects.toThrow(
      /No se ha encontrado texto legible/i,
    );
  });

  it("Mammoth conversion warnings are surfaced to the diagnostics store", async () => {
    // A paragraph style referenced without being defined in styles.xml makes
    // Mammoth emit a real "referenced but not defined" warning. It must reach
    // the laboratory diagnostics store instead of vanishing.
    const unknownStyle =
      `<w:p><w:pPr><w:pStyle w:val="EstiloFantasmaSinDefinir"/></w:pPr>` +
      `<w:r><w:t>texto con estilo raro</w:t></w:r></w:p>`;
    const docx = await buildDocx({
      items: [{ type: "para", text: "párrafo sano antes del estilo raro." }],
      raw: unknownStyle,
    });
    const d = await loadDocx("warn.docx", docx.buffer);
    expect(d.blocks.length).toBeGreaterThan(0);
    const diags = getParserDiagnostics().filter((x) => x.source === "mammoth-docx");
    expect(diags.length).toBeGreaterThan(0);
    expect(
      diags.some(
        (x) => x.level === "warning" && /EstiloFantasmaSinDefinir/.test(x.message),
      ),
    ).toBe(true);
    // The document itself stays readable and normal.
    expect(d.blocks.map((b) => b.text).join(" ")).toContain("párrafo sano");
  });
});
