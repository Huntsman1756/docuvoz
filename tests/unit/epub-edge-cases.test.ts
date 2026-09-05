/**
 * Part 11 — EPUB edge cases (unit level, real vendored foliate-js parser,
 * no DRM bypass, real JSZip loader).
 */
import { describe, expect, it } from "vitest";
import { epubAdapter } from "@/adapters/document-parsers/adapters/epub-adapter";
import {
  asFile,
  buildEpub,
  buildSampleEpub,
  sampleEpubOptions,
  DRM_ENCRYPTION_XML,
  type EpubBuildOptions,
} from "../e2e/helpers/doc-fixtures";

async function load(overrides: Partial<EpubBuildOptions>) {
  const file = asFile(await buildEpub(sampleEpubOptions(overrides)));
  return epubAdapter.load(file, { id: "edge", name: "edge.epub" });
}

describe("EPUB edge cases", () => {
  it("EPUB3 + nav document: metadata, TOC, spine order", async () => {
    const doc = await load({ version: 3 });
    expect(doc.source.name).toBe("Aventuras de DocuVoz");
    expect(doc.source.author).toBe("Ana Ejemplo");
    expect(doc.source.language).toBe("es");
    expect(doc.toc && doc.toc.length).toBeGreaterThan(0);
    expect(doc.blocks[0].text).toContain("Capítulo 1");
  });

  it("EPUB2 + NCX: TOC and spine resolve through the NCX map", async () => {
    const doc = await load({ version: 2 });
    expect(doc.parser).toBe("foliate-epub");
    expect(doc.toc && doc.toc.length).toBeGreaterThan(0);
    const texts = doc.blocks.map((b) => b.text).join(" ");
    expect(texts).toContain("El faro de DocuVoz");
    expect(texts).toContain("isla de cristal");
  });

  it("nested TOC is flattened with increasing depth", async () => {
    const doc = await load({ version: 3 });
    expect(doc.toc).toBeDefined();
    const depths = doc.toc!.map((t) => t.depth);
    // the fixture nests "Capítulo 1/2" under "Primera parte"
    expect(Math.max(...depths)).toBeGreaterThanOrEqual(1);
  });

  it("missing TOC still yields ordered readable blocks", async () => {
    const doc = await load({ toc: null });
    expect(doc.toc).toBeUndefined();
    expect(doc.blocks.length).toBeGreaterThan(3);
  });

  it("missing title falls back to the filename", async () => {
    const doc = await load({ title: null });
    expect(doc.source.name).toBe("edge.epub");
  });

  it("missing author yields no author, without error", async () => {
    const doc = await load({ authors: [] });
    expect(doc.source.author).toBeUndefined();
  });

  it("multiple authors are joined", async () => {
    const doc = await load({ authors: ["Ana Ejemplo", "Beto Ejemplar"] });
    expect(doc.source.author).toBe("Ana Ejemplo, Beto Ejemplar");
  });

  it("language metadata is honoured", async () => {
    const doc = await load({ language: "ca" });
    expect(doc.source.language).toBe("ca");
  });

  it("RTL spine direction is captured", async () => {
    const doc = await load({ rtl: true });
    expect(doc.dir).toBe("rtl");
  });

  it("malformed container.xml fails with a clear, non-crashing error", async () => {
    await expect(load({ breakContainer: true })).rejects.toThrow(/EPUB/i);
  });

  it("truncated OPF fails cleanly", async () => {
    await expect(load({ breakOpf: true })).rejects.toThrow(/EPUB/i);
  });

  it("DRM (content encryption) is rejected with an unsupported message, no bypass", async () => {
    await expect(load({ encryptionXml: DRM_ENCRYPTION_XML })).rejects.toThrow(
      /protegido|DRM/i,
    );
  });

  it("font-only stream obfuscation is NOT treated as DRM", async () => {
    // CipherReference targets a font, not a content document → must open.
    const fontObfuscation = `<?xml version="1.0"?><Encryption xmlns="http://www.w3.org/2001/04/xmlenc#"><EncryptedData><EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding/font-obf"/><CipherData><CipherReference URI="OEBPS/font.woff"/></CipherData></EncryptedData></Encryption>`;
    const doc = await load({ encryptionXml: fontObfuscation });
    expect(doc.blocks.length).toBeGreaterThan(0);
  });

  it("fixed-layout rendition still parses into readable blocks", async () => {
    const doc = await load({ fixedLayout: true });
    expect(doc.blocks.length).toBeGreaterThan(0);
  });

  it("one very large chapter is fully extracted in order", async () => {
    const many = Array.from(
      { length: 400 },
      (_, i) => `<p>Parrafo numero ${i} del capitulo largo.</p>`,
    ).join("");
    const doc = await load({
      chapters: [{ file: "big.xhtml", title: "Grande", body: `<h1>Grande</h1>${many}` }],
      toc: [{ label: "Grande", href: "big.xhtml" }],
    });
    const paras = doc.blocks.filter((b) => b.text.startsWith("Parrafo numero"));
    expect(paras.length).toBe(400);
    expect(paras[0].text).toContain("numero 0");
    expect(paras[399].text).toContain("numero 399");
    // source order preserved
    for (let i = 1; i < paras.length; i++) {
      expect(paras[i].order).toBeGreaterThan(paras[i - 1].order);
    }
  }, 20_000);

  it("many small spine sections keep section indices monotonic", async () => {
    const chapters = Array.from({ length: 60 }, (_, i) => ({
      file: `s${i}.xhtml`,
      title: `Mini ${i}`,
      body: `<h1>Mini ${i}</h1><p>Seccion pequena ${i}.</p>`,
    }));
    const doc = await load({
      chapters,
      toc: chapters.map((c) => ({ label: c.title, href: c.file })),
    });
    const sectionIdx = doc.blocks.map((b) => b.sectionIndex ?? -1);
    for (let i = 1; i < sectionIdx.length; i++) {
      expect(sectionIdx[i]).toBeGreaterThanOrEqual(sectionIdx[i - 1]);
    }
    expect(new Set(sectionIdx).size).toBeGreaterThanOrEqual(60);
  }, 20_000);

  it("non-linear spine entries are skipped, not spoken", async () => {
    const doc = await load({
      chapters: [
        { file: "a.xhtml", title: "A", body: `<h1>A</h1><p>contenido lineal A.</p>` },
        {
          file: "hidden.xhtml",
          title: "Oculto",
          nonLinear: true,
          body: `<p>esto no debe escucharse zzwz</p>`,
        },
      ],
      toc: [{ label: "A", href: "a.xhtml" }],
    });
    expect(doc.blocks.some((b) => b.text.includes("zzwz"))).toBe(false);
    expect(doc.blocks.some((b) => b.text.includes("lineal A"))).toBe(true);
  });

  it("stable source refs and CFI survive into every block", async () => {
    const doc = await buildSampleEpub()
      .then(asFile)
      .then((f) => epubAdapter.load(f, { id: "cfi", name: "s.epub" }));
    for (const b of doc.blocks) {
      expect(b.sourceRef).toMatch(/#p\d+$/);
      expect(b.sourceCfi ?? undefined).toMatch(/^epubcfi\(/);
    }
  });
});
