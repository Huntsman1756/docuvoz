/**
 * Tests for HTML document adapter.
 *
 * DOMPurify is mocked globally via tests/setup.ts for Node.js environment.
 */
import { describe, it, expect } from "vitest";
import { htmlAdapter } from "@/adapters/document-parsers/adapters/html-adapter";

function makeFile(content: string, name = "test.html", type = "text/html"): File {
  return new File([content], name, { type });
}

describe("htmlAdapter", () => {
  it("has correct id", () => {
    expect(htmlAdapter.id).toBe("html-dom");
  });

  it("supports .html and .htm extensions", () => {
    expect(htmlAdapter.extensions).toContain(".html");
    expect(htmlAdapter.extensions).toContain(".htm");
  });

  it("canOpen returns true for .html files", () => {
    expect(htmlAdapter.canOpen(makeFile("", "page.html"))).toBe(true);
    expect(htmlAdapter.canOpen(makeFile("", "page.htm"))).toBe(true);
  });

  it("extracts paragraphs", async () => {
    const html = `<html><body>
      <p>First paragraph.</p>
      <p>Second paragraph.</p>
    </body></html>`;
    const doc = await htmlAdapter.load(makeFile(html), {
      id: "test-para",
      name: "test.html",
    });

    const paras = doc.blocks.filter((b) => b.type === "paragraph");
    expect(paras.length).toBe(2);
    expect(paras[0].text).toBe("First paragraph.");
    expect(paras[1].text).toBe("Second paragraph.");
  });

  it("strips script tags via DOMPurify", async () => {
    const html = `<html><body>
      <p>Safe text.</p>
      <script>alert('xss')</script>
      <p>More safe text.</p>
    </body></html>`;
    const doc = await htmlAdapter.load(makeFile(html), {
      id: "test-script",
      name: "test.html",
    });

    const allText = doc.blocks.map((b) => b.text).join(" ");
    expect(allText).not.toContain("alert");
    expect(allText).toContain("Safe text.");
    expect(allText).toContain("More safe text.");
  });

  it("strips iframe tags via DOMPurify", async () => {
    const html = `<html><body>
      <p>Content.</p>
      <iframe src="https://evil.com"></iframe>
    </body></html>`;
    const doc = await htmlAdapter.load(makeFile(html), {
      id: "test-iframe",
      name: "test.html",
    });

    const allText = doc.blocks.map((b) => b.text).join(" ");
    expect(allText).not.toContain("evil.com");
  });

  it("throws on empty HTML", async () => {
    const file = makeFile("<html><body></body></html>");
    await expect(
      htmlAdapter.load(file, { id: "test-empty", name: "empty.html" }),
    ).rejects.toThrow("No se ha encontrado texto legible");
  });
});
