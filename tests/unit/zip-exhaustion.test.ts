/**
 * Part 6 — ZIP / resource-exhaustion audit and adapter-level limits.
 *
 * Verifies that the metadata ceilings in zip-limits.ts reject adversarial
 * archives *before* inflation. The "declared size" attack is forged the real
 * way — by rewriting uncompressed-size fields in the local + central headers —
 * not by mutating JSZip's in-memory state, so the guard is exercised through
 * exactly the central-directory read JSZip performs at load time.
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";
import {
  ZIP_LIMITS,
  enforceZipLimits,
  entryUncompressedSize,
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

/**
 * Rewrite the uncompressed-size field of `entryName` in both the local file
 * header (offset 22) and central directory header (offset 24). JSZip trusts
 * the central-directory value at load time (no inflation), which is precisely
 * the metadata enforceZipLimits must police.
 */
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

describe("entryUncompressedSize", () => {
  it("reads central-directory size and returns -1 for unknown", () => {
    expect(entryUncompressedSize({ _data: { uncompressedSize: 1234 } })).toBe(1234);
    expect(entryUncompressedSize({})).toBe(-1);
    expect(entryUncompressedSize(null)).toBe(-1);
    expect(entryUncompressedSize({ _data: { uncompressedSize: -5 } })).toBe(-1);
  });
});

describe("enforceZipLimits (pure, on a real parsed archive)", () => {
  it("passes a normal small archive", async () => {
    const zip = new JSZip();
    zip.file("a.txt", "hola".repeat(10));
    expect(() => enforceZipLimits(zip)).not.toThrow();
  });

  it("rejects a single entry past the ceiling", async () => {
    const zip = await JSZip.loadAsync(
      forgeDeclaredSize(
        await (
          await buildSampleEpub()
        ).buffer,
        "OEBPS/chap1.xhtml",
        200 * 1024 * 1024,
      ),
    );
    expect(() => enforceZipLimits(zip, ZIP_LIMITS, "EPUB")).toThrow(/máximo seguro/i);
  });

  it("rejects when the total expanded size exceeds the ceiling", async () => {
    // Forge five entries at 55 MiB each: every one passes the 64 MiB per-entry
    // ceiling but the sum (275 MiB) trips the 256 MiB total ceiling.
    let buf = await (await buildSampleEpub()).buffer;
    for (const entry of [
      "OEBPS/chap1.xhtml",
      "OEBPS/chap2.xhtml",
      "OEBPS/chap3.xhtml",
      "OEBPS/notes.xhtml",
      "OEBPS/nav.xhtml",
    ]) {
      buf = forgeDeclaredSize(buf, entry, 55 * 1024 * 1024);
    }
    const zip = await JSZip.loadAsync(buf);
    expect(() => enforceZipLimits(zip, ZIP_LIMITS, "EPUB")).toThrow(/m[áa]s de 256 MB/i);
  });

  it("rejects absurd entry counts", async () => {
    const zip = new JSZip();
    for (let i = 0; i < ZIP_LIMITS.maxEntries + 5; i++) zip.file(`e${i}.txt`, "x");
    expect(() => enforceZipLimits(zip, ZIP_LIMITS, "EPUB")).toThrow(
      /demasiados elementos/i,
    );
  });
});

describe("epubAdapter resource-exhaustion guards", () => {
  const legit = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml"><body><p>contenido legítimo del libro</p></body></html>`;

  it("accepts a realistic multi-chapter EPUB well under the limits", async () => {
    const doc = await epubAdapter.load(asFile(await buildSampleEpub()), {
      id: "epub-ok",
      name: "s.epub",
    });
    expect(doc.blocks.length).toBeGreaterThan(0);
  });

  it("rejects a zip-bomb-shaped chapter (declared single-entry blowup) before inflation", async () => {
    const zip = new JSZip();
    epubShell(zip, legit);
    const buffer = forgeDeclaredSize(
      await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" }),
      "OEBPS/chap1.xhtml",
      200 * 1024 * 1024,
    );
    const file = new File([new Uint8Array(buffer)], "bomb.epub", {
      type: "application/epub+zip",
    });
    await expect(
      epubAdapter.load(file, { id: "bomb", name: "bomb.epub" }),
    ).rejects.toThrow(/m[áa]ximo seguro|descomprime/i);
  });

  it("rejects a package with far too many entries", async () => {
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
    ).rejects.toThrow(/demasiados elementos/i);
  }, 40_000);
});

describe("docxAdapter resource-exhaustion guards", () => {
  it("rejects a DOCX whose central directory reports an absurd single-entry size", async () => {
    const docx = await buildDocx({
      name: "big.docx",
      items: [{ type: "para", text: "contenido normal que nunca debe descomprimirse" }],
    });
    const buffer = forgeDeclaredSize(docx.buffer, "word/document.xml", 100 * 1024 * 1024);
    const file = new File([new Uint8Array(buffer)], "big.docx", {
      type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    });
    await expect(
      docxAdapter.load(file, { id: "bigdocx", name: "big.docx" }),
    ).rejects.toThrow(/m[áa]ximo seguro|descomprime/i);
  });

  it("accepts a normal DOCX (limits must never trip on legitimate documents)", async () => {
    const docx = await buildDocx({
      name: "ok.docx",
      items: [{ type: "para", text: "documento perfectamente normal." }],
    });
    const doc = await docxAdapter.load(asFile(docx), { id: "ok", name: "ok.docx" });
    expect(doc.blocks.length).toBeGreaterThan(0);
  });
});
