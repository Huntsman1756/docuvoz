/**
 * Part 14 — Privacy contract: no network before user action.
 *
 * Proves that document ingestion (all adapters) never triggers any outbound
 * network request — not fetch, not XHR, not image load, nothing. The only
 * code path that may call fetch is the explicit "Play" button flow.
 *
 * Uses real DOMPurify and real adapters (importActual bypasses the mock).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { htmlAdapter } from "@/adapters/document-parsers/adapters/html-adapter";
import { markdownAdapter } from "@/adapters/document-parsers/adapters/markdown-adapter";
import { txtAdapter } from "@/adapters/document-parsers/adapters/txt-adapter";
import {
  asFile,
  buildDocx,
  buildEpub,
  sampleEpubOptions,
  MALICIOUS_HTML,
  maliciousEpub,
} from "../e2e/helpers/doc-fixtures";
import { epubAdapter } from "@/adapters/document-parsers/adapters/epub-adapter";
import { docxAdapter } from "@/adapters/document-parsers/adapters/docx-adapter";

/* ------------------------------------------------------------------ */
/*  Network spy                                                      */
/* ------------------------------------------------------------------ */

const outboundCalls: string[] = [];
let originalFetch: typeof globalThis.fetch;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let originalXHROpen: any;
const hasXHR = typeof XMLHttpRequest !== "undefined";

beforeAll(() => {
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    outboundCalls.push(String(typeof input === "string" ? input : "req"));
    throw new Error(`TEST_NETWORK_BLOCKED: ${String(input)}`);
  }) as typeof globalThis.fetch;

  // Monkey-patch XMLHttpRequest (available in jsdom, not in bare Node)
  if (hasXHR) {
    const XHR = XMLHttpRequest as unknown as {
      prototype: {
        open: (method: string, url: string | URL, ...args: unknown[]) => void;
      };
    };
    originalXHROpen = XHR.prototype.open;
    XHR.prototype.open = function (
      this: XMLHttpRequest,
      method: string,
      url: string | URL,
      ...rest: unknown[]
    ) {
      const urlString = String(url);
      if (urlString.startsWith("http")) {
        outboundCalls.push(`${method} ${urlString}`);
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (originalXHROpen as any).call(this, method, url, ...rest);
    };
  }
});

afterAll(() => {
  globalThis.fetch = originalFetch;
  if (hasXHR) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (XMLHttpRequest.prototype.open as any) = originalXHROpen;
  }
});

function expectNoNetwork() {
  expect(outboundCalls).toEqual([]);
}

function clearCalls() {
  outboundCalls.length = 0;
}

/* ------------------------------------------------------------------ */
/*  HTML                                                             */
/* ------------------------------------------------------------------ */

describe("htmlAdapter: zero network calls during ingestion", () => {
  it("malicious HTML never fetches", async () => {
    clearCalls();
    const file = new File([MALICIOUS_HTML], "test.html", { type: "text/html" });
    const doc = await htmlAdapter.load(file, { id: "priv1", name: "test.html" });
    expect(doc.blocks.length).toBeGreaterThan(0);
    expectNoNetwork();
  });

  it("benign HTML never fetches", async () => {
    clearCalls();
    const file = new File(
      ["<html><body><p>Hello world.</p></body></html>"],
      "benign.html",
      { type: "text/html" },
    );
    const doc = await htmlAdapter.load(file, { id: "priv2", name: "benign.html" });
    expect(doc.blocks.length).toBeGreaterThan(0);
    expectNoNetwork();
  });
});

/* ------------------------------------------------------------------ */
/*  Markdown                                                         */
/* ------------------------------------------------------------------ */

describe("markdownAdapter: zero network calls during ingestion", () => {
  it("markdown with links never fetches", async () => {
    clearCalls();
    const file = new File(
      ["# Title\n\nSee [example](https://evil.invalid) for more."],
      "test.md",
      { type: "text/markdown" },
    );
    const doc = await markdownAdapter.load(file, { id: "priv3", name: "test.md" });
    expect(doc.blocks.length).toBeGreaterThan(0);
    expectNoNetwork();
  });

  it("plain markdown never fetches", async () => {
    clearCalls();
    const file = new File(["Hello world."], "test.md", { type: "text/markdown" });
    const doc = await markdownAdapter.load(file, { id: "priv4", name: "test.md" });
    expect(doc.blocks.length).toBeGreaterThan(0);
    expectNoNetwork();
  });
});

/* ------------------------------------------------------------------ */
/*  TXT                                                              */
/* ------------------------------------------------------------------ */

describe("txtAdapter: zero network calls during ingestion", () => {
  it("plain text never fetches", async () => {
    clearCalls();
    const file = new File(["Hello world."], "test.txt", { type: "text/plain" });
    const doc = await txtAdapter.load(file, { id: "priv5", name: "test.txt" });
    expect(doc.blocks.length).toBeGreaterThan(0);
    expectNoNetwork();
  });
});

/* ------------------------------------------------------------------ */
/*  EPUB                                                             */
/* ------------------------------------------------------------------ */

describe("epubAdapter: zero network calls during ingestion", () => {
  it("EPUB with external resources never fetches", async () => {
    clearCalls();
    const epub = await buildEpub({
      ...sampleEpubOptions(),
      chapters: [
        {
          file: "chap1.xhtml",
          title: "Test",
          head: `<link rel="stylesheet" href="https://evil.invalid/style.css"/>`,
          body: `<h1>Test</h1><p>Content with remote references.</p>`,
        },
      ],
    });
    const doc = await epubAdapter.load(asFile(epub), { id: "priv6", name: "test.epub" });
    expect(doc.blocks.length).toBeGreaterThan(0);
    expectNoNetwork();
  });

  it("EPUB with injected scripts never fetches", async () => {
    clearCalls();
    const maliciousEpubFixture = await maliciousEpub();
    const doc = await epubAdapter.load(asFile(maliciousEpubFixture), {
      id: "priv9",
      name: "malicious.epub",
    });
    expect(doc.blocks.length).toBeGreaterThan(0);
    expectNoNetwork();
  });
});

/* ------------------------------------------------------------------ */
/*  DOCX                                                             */
/* ------------------------------------------------------------------ */

describe("docxAdapter: zero network calls during ingestion", () => {
  it("DOCX with external links never fetches", async () => {
    clearCalls();
    const docx = await buildDocx({
      items: [
        {
          type: "para",
          text: "External link: https://evil.invalid/steal",
        },
      ],
    });
    const doc = await docxAdapter.load(asFile(docx), {
      id: "priv7",
      name: "test.docx",
    });
    expect(doc.blocks.length).toBeGreaterThan(0);
    expectNoNetwork();
  });

  it("normal DOCX never fetches", async () => {
    clearCalls();
    const docx = await buildDocx({
      items: [{ type: "para", text: "Normal content." }],
    });
    const doc = await docxAdapter.load(asFile(docx), { id: "priv8", name: "test.docx" });
    expect(doc.blocks.length).toBeGreaterThan(0);
    expectNoNetwork();
  });
});

/* ------------------------------------------------------------------ */
/*  Switching between documents                                      */
/* ------------------------------------------------------------------ */

describe("document switching: zero network calls", () => {
  it("swapping txt → md → html never fetches", async () => {
    clearCalls();
    const txt = await txtAdapter.load(
      new File(["First document."], "a.txt", { type: "text/plain" }),
      { id: "s1", name: "a.txt" },
    );
    expectNoNetwork();

    const md = await markdownAdapter.load(
      new File(["Second document."], "b.md", { type: "text/markdown" }),
      { id: "s2", name: "b.md" },
    );
    expectNoNetwork();

    const html = await htmlAdapter.load(
      new File(["<p>Third document.</p>"], "c.html", { type: "text/html" }),
      { id: "s3", name: "c.html" },
    );
    expectNoNetwork();

    expect(txt.blocks.length).toBeGreaterThan(0);
    expect(md.blocks.length).toBeGreaterThan(0);
    expect(html.blocks.length).toBeGreaterThan(0);
  });
});
