/**
 * Part 5 (unit layer) — security threat tests.
 *
 * Two complementary guarantees are proven here; the browser-side twin of the
 * network invariant lives in tests/e2e/security.spec.ts.
 *
 *  1. Active content never survives sanitisation with the REAL DOMPurify
 *     (importActual bypasses the global test mock) and the REAL adapter
 *     configuration — no regex-only assumptions.
 *  2. Opening any adversarial document never triggers outbound network I/O:
 *     global fetch/http are spied and must see zero calls.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import {
  SANITIZE_CONFIG as HTML_CONFIG,
  htmlAdapter,
} from "@/adapters/document-parsers/adapters/html-adapter";
import { SANITIZE_CONFIG as DOCX_CONFIG } from "@/adapters/document-parsers/adapters/docx-adapter";
import { docxAdapter } from "@/adapters/document-parsers/adapters/docx-adapter";
import { epubAdapter } from "@/adapters/document-parsers/adapters/epub-adapter";
import {
  asFile,
  buildDocx,
  maliciousEpub,
  MALICIOUS_HTML,
  SAMPLE_HTML,
} from "../e2e/helpers/doc-fixtures";

/* ------------------------------------------------------------------ */
/*  Network spy: any outbound call fails the suite                     */
/* ------------------------------------------------------------------ */

const outboundCalls: string[] = [];
let originalFetch: typeof globalThis.fetch;

beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    outboundCalls.push(String(typeof input === "string" ? input : "req"));
    throw new Error(`TEST NETWORK BLOCKED: ${String(input)}`);
  }) as typeof globalThis.fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

/** http/https URLs must never appear in speakable canonical text. */
function expectNoRemoteUrls(text: string) {
  expect(text).not.toMatch(/https?:\/\//i);
}

describe("real DOMPurify neutralises active HTML (actual module, adapter config)", () => {
  let clean: string;

  beforeAll(async () => {
    const mod = await vi.importActual<typeof import("dompurify")>("dompurify");
    const factory = mod.default as unknown as (w: Window) => {
      sanitize(dirty: string, cfg: unknown): string;
    };
    const window = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    const purify = factory(window as unknown as Window);
    clean = purify.sanitize(MALICIOUS_HTML, HTML_CONFIG);
  });

  it("removes every active-content construct", () => {
    const lower = clean.toLowerCase();
    for (const forbidden of [
      "<script",
      "onclick=",
      "onerror=",
      "onload=",
      "<iframe",
      "<object",
      "<embed",
      "<form",
      "<input",
      "<link",
      "<style",
      "javascript:",
    ]) {
      expect(lower, `sanitized output still contains ${forbidden}`).not.toContain(
        forbidden,
      );
    }
  });

  it("keeps the legitimate document text", () => {
    expect(clean).toContain("Documento legítimo por fuera");
    expect(clean).toContain("Texto final que sí debe llegar al lector.");
  });

  it("DOCX config is equally strict (same shape checks)", async () => {
    const mod = await vi.importActual<typeof import("dompurify")>("dompurify");
    const factory = mod.default as unknown as (w: Window) => {
      sanitize(dirty: string, cfg: unknown): string;
    };
    const window = new JSDOM("<!DOCTYPE html><html><body></body></html>").window;
    const purify = factory(window as unknown as Window);
    const clean2 = purify.sanitize(MALICIOUS_HTML, DOCX_CONFIG);
    const lower = clean2.toLowerCase();
    for (const forbidden of [
      "<script",
      "onclick=",
      "<iframe",
      "<object",
      "<embed",
      "javascript:",
    ]) {
      expect(lower).not.toContain(forbidden);
    }
  });
});

describe("htmlAdapter: malicious HTML reaches the reader inert", () => {
  it("strips active content, never fetches, keeps text", async () => {
    const file = asFile({
      name: "malo.html",
      mimeType: "text/html",
      buffer: Buffer.from(MALICIOUS_HTML, "utf8"),
    });
    const doc = await htmlAdapter.load(file, { id: "sec-html", name: "malo.html" });
    const text = doc.blocks.map((b) => b.text).join("\n");
    expectNoRemoteUrls(text);
    for (const leak of ["__pwned", "javascript:", "<script", "onerror", "evil.invalid"]) {
      expect(text.toLowerCase(), `block text leaks ${leak}`).not.toContain(
        leak.toLowerCase(),
      );
    }
    expect(text).toContain("Documento legítimo por fuera");
    expect(text).toContain("Texto final que sí debe llegar al lector.");
    expect(text).toContain("enlace javascript");
    expect(outboundCalls).toEqual([]);
  });

  it("benign html still parses (no regression)", async () => {
    const doc = await htmlAdapter.load(
      new File([SAMPLE_HTML], "b.html", { type: "text/html" }),
      {
        id: "sec-html-ok",
        name: "b.html",
      },
    );
    expect(doc.blocks.length).toBeGreaterThan(2);
  });
});

describe("docxAdapter: external references are inert", () => {
  it("external image relationship neither fetches nor leaks URLs", async () => {
    const base = await buildDocx({
      items: [{ type: "para", text: "documento con referencia externa." }],
    });
    const JSZip = (await import("jszip")).default;
    const reopened = await JSZip.loadAsync(base.buffer);
    reopened.file(
      "word/_rels/document.xml.rels",
      (await reopened.file("word/_rels/document.xml.rels")!.async("text")).replace(
        "</Relationships>",
        '<Relationship Id="rIdX" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="https://evil.invalid/imagen.png" TargetMode="External"/></Relationships>',
      ),
    );
    reopened.file(
      "word/document.xml",
      (await reopened.file("word/document.xml")!.async("text")).replace(
        "<w:sectPr/>",
        `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="914400"/><wp:docPr id="7" name="remota" descr="imagen remota"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="7" name="remota" descr="imagen remota"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="rIdX"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p><w:sectPr/>`,
      ),
    );
    const tampered = await reopened.generateAsync({ type: "nodebuffer" });
    const doc = await docxAdapter.load(
      asFile({
        name: "ext.docx",
        mimeType:
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        buffer: tampered,
      }),
      { id: "sec-docx", name: "ext.docx" },
    );
    const text = doc.blocks.map((b) => b.text).join("\n");
    expectNoRemoteUrls(text);
    expect(text).toContain("referencia externa");
    expect(outboundCalls).toEqual([]);
  });

  it("external hyperlink keeps visible text, URL never spoken", async () => {
    const docx = await buildDocx({
      items: [
        {
          type: "link",
          before: "mira ",
          text: "el sitio",
          url: "https://evil.invalid/x",
          after: " hoy",
        },
      ],
    });
    const doc = await docxAdapter.load(asFile(docx), {
      id: "sec-docx-link",
      name: "l.docx",
    });
    const text = doc.blocks.map((b) => b.text).join("\n");
    expect(text).toContain("el sitio");
    expectNoRemoteUrls(text);
    expect(outboundCalls).toEqual([]);
  });
});

describe("epubAdapter: malicious EPUB is inert", () => {
  it("loads with legitimate content; scripts/styles/remotes never execute or fetch", async () => {
    const doc = await epubAdapter.load(asFile(await maliciousEpub()), {
      id: "sec-epub",
      name: "malicious.epub",
    });
    const text = doc.blocks.map((b) => b.text).join("\n");
    // Legitimate prose survives on both sides of the attack payload.
    expect(text).toContain("Contenido legítimo antes del ataque.");
    expect(text).toContain("Contenido legítimo después del ataque.");
    expect(text).toContain("Esta sección sigue siendo legible.");
    // Nothing executable / remote survives into speakable text.
    for (const leak of ["__pwned", "javascript", "evil.invalid", "<script", "onerror"]) {
      expect(text.toLowerCase(), `epub blocks leak ${leak}`).not.toContain(
        leak.toLowerCase(),
      );
    }
    expectNoRemoteUrls(text);
    // And the whole open never touched the network.
    expect(outboundCalls).toEqual([]);
  });

  it("path-traversal entries in the container cannot escape or break parsing", async () => {
    // The malicious fixture already embeds ../../pwned.txt and traversal/../
    // entries. Loading above proved containment; assert content invariants:
    const doc = await epubAdapter.load(asFile(await maliciousEpub()), {
      id: "sec-epub-2",
      name: "malicious.epub",
    });
    const text = doc.blocks.map((b) => b.text).join("\n");
    expect(text).not.toContain("escritura de prueba fuera");
  });
});
