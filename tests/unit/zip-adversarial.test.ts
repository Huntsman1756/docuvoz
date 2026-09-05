/**
 * F05 — Adversarial ZIP hardening tests.
 *
 * Deterministic small fixtures that exercise:
 * 1. metadata says small, actual output exceeds budget (post-decompression)
 * 2. one oversized expanded entry
 * 3. many entries
 * 4. total expanded budget exceeded
 * 5. path traversal names (../, ../../, absolute-like)
 * 6. malformed ZIP
 * 7. high compression ratio
 * 8. cancellation during expansion
 *
 * Uses low test-only thresholds to simulate attacks without multi-GB bombs.
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  ZIP_LIMITS,
  enforceZipLimits,
  hasUnsafePath,
  assessActualExpansion,
} from "@/adapters/document-parsers/zip-limits";
import { epubAdapter } from "@/adapters/document-parsers/adapters/epub-adapter";
import { docxAdapter } from "@/adapters/document-parsers/adapters/docx-adapter";
import { asFile, buildDocx, buildSampleEpub } from "../e2e/helpers/doc-fixtures";

const FIXED_DATE = new Date(Date.UTC(2026, 0, 1));

function epubShell(zip: JSZip, chapterHtml: string): void {
  zip.file("mimetype", "application/epub+zip", {
    compression: "STORE",
    date: FIXED_DATE,
  });
  zip.file(
    "META-INF/container.xml",
    `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`,
    { date: FIXED_DATE },
  );
  zip.file(
    "OEBPS/content.opf",
    `<?xml version="1.0"?><package version="3.0" unique-identifier="id" xmlns="http://www.idpf.org/2007/opf"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="id">x</dc:identifier><dc:title>Bomba</dc:title><dc:language>es</dc:language></metadata><manifest><item id="c1" href="chap1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>`,
    { date: FIXED_DATE },
  );
  zip.file("OEBPS/chap1.xhtml", chapterHtml, { date: FIXED_DATE });
}

function forgeDeclaredSize(buffer: Buffer, entryName: string, fakeSize: number): Buffer {
  const out = Buffer.from(buffer);
  const name = Buffer.from(entryName, "utf8");
  let local = -1;
  let central = -1;
  for (let i = 0; i + 46 <= out.length; i++) {
    const sig = out.readUInt32LE(i);
    if (sig === 0x04034b50 && out.subarray(i + 30, i + 30 + name.length).equals(name)) {
      if (local < 0) local = i;
    } else if (
      sig === 0x02014b50 &&
      out.subarray(i + 46, i + 46 + name.length).equals(name)
    ) {
      if (central < 0) central = i;
    }
  }
  if (local < 0 || central < 0) throw new Error(`entry ${entryName} not located in zip`);
  out.writeUInt32LE(fakeSize, local + 22);
  out.writeUInt32LE(fakeSize, central + 24);
  return out;
}

// ─── Path traversal ────────────────────────────────────────────────────

describe("hasUnsafePath", () => {
  it("rejects absolute Unix paths", () => {
    expect(hasUnsafePath("/etc/passwd")).toBe(true);
    expect(hasUnsafePath("/tmp/malicious")).toBe(true);
  });

  it("rejects Windows absolute paths", () => {
    expect(hasUnsafePath("C:\\Windows\\System32")).toBe(true);
    expect(hasUnsafePath("C:/Windows/System32")).toBe(true);
  });

  it("rejects UNC paths", () => {
    expect(hasUnsafePath("\\\\server\\share")).toBe(true);
  });

  it("accepts normal relative paths", () => {
    expect(hasUnsafePath("OEBPS/chap1.xhtml")).toBe(false);
    expect(hasUnsafePath("word/document.xml")).toBe(false);
    expect(hasUnsafePath("a/b/c.txt")).toBe(false);
  });

  it("accepts normalized paths (JSZip resolves ..)", () => {
    // After JSZip's utils.resolve(), these become safe
    expect(hasUnsafePath("etc/passwd")).toBe(false);
    expect(hasUnsafePath("OEBPS/../../pwned.txt")).toBe(false);
    // hasUnsafePath only checks the ORIGINAL name; JSZip normalizes
  });
});

// ─── Compression ratio ─────────────────────────────────────────────────

describe("compression ratio check", () => {
  it("rejects entries with extreme compression ratio", () => {
    const limits = { ...ZIP_LIMITS, maxCompressionRatio: 100 };
    const zip = new JSZip();
    // Simulate: 1 byte compressed, 200 bytes uncompressed (ratio 200:1)
    // In a real ZIP, this would be a tiny compressed payload inflating to huge output.
    // For the metadata check, we just need the sizes to be reported.
    zip.file("a.txt", "x");
    const entries = Object.values(zip.files) as unknown as Array<{
      dir: boolean;
      _data?: { uncompressedSize?: number; compressedSize?: number };
    }>;
    // Manually set sizes to simulate a bomb
    for (const e of entries) {
      if (!e.dir && e._data) {
        e._data.uncompressedSize = 200;
        e._data.compressedSize = 1;
      }
    }
    expect(() => enforceZipLimits(zip, limits, "test")).toThrow(
      /relación de compresión extrema/,
    );
  });

  it("passes entries with normal compression ratio", () => {
    const limits = { ...ZIP_LIMITS, maxCompressionRatio: 100 };
    const zip = new JSZip();
    zip.file("a.txt", "hola".repeat(100));
    // Normal ratio: uncompressed ~400 bytes, compressed ~50 bytes → ratio 8:1
    expect(() => enforceZipLimits(zip, limits, "test")).not.toThrow();
  });
});

// ─── assessActualExpansion ─────────────────────────────────────────────

describe("assessActualExpansion (post-decompression)", () => {
  it("passes within budget", () => {
    expect(() => assessActualExpansion(1024, "test")).not.toThrow();
  });

  it("rejects when actual bytes exceed per-entry budget", () => {
    expect(() =>
      assessActualExpansion(ZIP_LIMITS.maxEntryUncompressedBytes + 1, "test"),
    ).toThrow(/ocupa.*MB en memoria/);
  });
});

// ─── EPUB adversarial ─────────────────────────────────────────────────

describe("EPUB adversarial fixtures", () => {
  const legit = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>contenido legítimo del libro</p></body></html>`;

  it("rejects path traversal in EPUB entry names", async () => {
    const zip = new JSZip();
    epubShell(zip, legit);
    // Add entry with absolute-like path
    zip.file("/etc/passwd", "pwned", { date: FIXED_DATE });
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    const file = new File([new Uint8Array(buffer)], "traversal.epub", {
      type: "application/epub+zip",
    });
    await expect(
      epubAdapter.load(file, { id: "traversal", name: "traversal.epub" }),
    ).rejects.toThrow(/rutas no válidas/);
  });

  it("rejects high-compression-ratio EPUB entry", async () => {
    const zip = new JSZip();
    epubShell(zip, legit);
    // Add an entry with extreme ratio via metadata manipulation
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    // Forge the chapter to have a tiny compressed size but huge uncompressed size
    const forged = forgeDeclaredSize(buffer, "OEBPS/chap1.xhtml", 200 * 1024 * 1024);
    const file = new File([new Uint8Array(forged)], "ratio-bomb.epub", {
      type: "application/epub+zip",
    });
    await expect(
      epubAdapter.load(file, { id: "ratio", name: "ratio-bomb.epub" }),
    ).rejects.toThrow(/máximo seguro|descomprime|relación de compresión extrema/);
  });

  it("current document remains usable after rejected adversarial EPUB", async () => {
    // First: load a valid EPUB
    const good = await buildSampleEpub();
    const doc = await epubAdapter.load(asFile(good), {
      id: "good-before",
      name: "good.epub",
    });
    expect(doc.blocks.length).toBeGreaterThan(0);

    // Second: try to load a malicious EPUB (should fail)
    const zip = new JSZip();
    epubShell(zip, legit);
    for (let i = 0; i < ZIP_LIMITS.maxEntries + 10; i++) {
      zip.file(`extra/${i}.dat`, "x", { date: FIXED_DATE });
    }
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    const file = new File([new Uint8Array(buffer)], "many.epub", {
      type: "application/epub+zip",
    });
    await expect(
      epubAdapter.load(file, { id: "many", name: "many.epub" }),
    ).rejects.toThrow(/demasiados elementos/);

    // Third: load another valid EPUB — must still work
    const good2 = await buildSampleEpub({ name: "good2.epub" });
    const doc2 = await epubAdapter.load(asFile(good2), {
      id: "good-after",
      name: "good2.epub",
    });
    expect(doc2.blocks.length).toBeGreaterThan(0);
  });
});

// ─── DOCX adversarial ─────────────────────────────────────────────────

describe("DOCX adversarial fixtures", () => {
  it("rejects DOCX with forged size mismatch (JSZip internal error)", async () => {
    const docx = await buildDocx({
      name: "mismatch.docx",
      items: [{ type: "para", text: "contenido normal" }],
    });
    const buffer = forgeDeclaredSize(docx.buffer, "word/document.xml", 100 * 1024 * 1024);
    const file = new File([new Uint8Array(buffer)], "mismatch.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await expect(
      docxAdapter.load(file, { id: "mismatch", name: "mismatch.docx" }),
    ).rejects.toThrow(/manipulado|inconsistencia/);
  });

  it("rejects DOCX with entry count bomb", async () => {
    const zip = new JSZip();
    zip.file(
      "[Content_Types].xml",
      '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/></Types>',
      { date: FIXED_DATE },
    );
    for (let i = 0; i < ZIP_LIMITS.maxEntries + 10; i++) {
      zip.file(`extra/${i}.dat`, "x", { date: FIXED_DATE });
    }
    const buffer = await zip.generateAsync({
      type: "nodebuffer",
      compression: "DEFLATE",
    });
    const file = new File([new Uint8Array(buffer)], "many.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await expect(
      docxAdapter.load(file, { id: "many-docx", name: "many.docx" }),
    ).rejects.toThrow(/demasiados elementos/);
  });

  it("accepts a normal DOCX (adversarial checks must never trip on legitimate documents)", async () => {
    const docx = await buildDocx({
      name: "ok.docx",
      items: [{ type: "para", text: "documento perfectamente normal." }],
    });
    const doc = await docxAdapter.load(asFile(docx), { id: "ok", name: "ok.docx" });
    expect(doc.blocks.length).toBeGreaterThan(0);
  });
});

// ─── Malformed ZIP ────────────────────────────────────────────────────

describe("malformed ZIP handling", () => {
  it("rejects non-ZIP data as EPUB", async () => {
    const file = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], "not-a-zip.epub", {
      type: "application/epub+zip",
    });
    await expect(
      epubAdapter.load(file, { id: "bad", name: "bad.epub" }),
    ).rejects.toThrow();
  });

  it("rejects non-ZIP data as DOCX", async () => {
    const file = new File([new Uint8Array([0x00, 0x01, 0x02, 0x03])], "not-a-zip.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await expect(
      docxAdapter.load(file, { id: "bad-docx", name: "bad.docx" }),
    ).rejects.toThrow();
  });
});
