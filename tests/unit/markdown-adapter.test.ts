/**
 * Tests for Markdown document adapter.
 */
import { describe, it, expect } from "vitest";
import { markdownAdapter } from "@/adapters/document-parsers/adapters/markdown-adapter";

function makeFile(content: string, name = "test.md"): File {
  return new File([content], name, { type: "text/markdown" });
}

describe("markdownAdapter", () => {
  it("has correct id", () => {
    expect(markdownAdapter.id).toBe("markdown-it");
  });

  it("supports .md extension", () => {
    expect(markdownAdapter.extensions).toContain(".md");
  });

  it("canOpen returns true for .md files", () => {
    expect(markdownAdapter.canOpen(makeFile("", "readme.md"))).toBe(true);
  });

  it("extracts headings with correct levels", async () => {
    const md = "# Title\n\n## Subtitle\n\n### Section\n\nParagraph text.";
    const doc = await markdownAdapter.load(makeFile(md), {
      id: "test-headings",
      name: "test.md",
    });

    const headings = doc.blocks.filter((b) => b.type === "heading");
    expect(headings.length).toBe(3);
    expect(headings[0].text).toBe("Title");
    expect(headings[0].level).toBe(1);
    expect(headings[1].text).toBe("Subtitle");
    expect(headings[1].level).toBe(2);
    expect(headings[2].text).toBe("Section");
    expect(headings[2].level).toBe(3);
  });

  it("extracts paragraphs", async () => {
    const md = "First paragraph.\n\nSecond paragraph.";
    const doc = await markdownAdapter.load(makeFile(md), {
      id: "test-para",
      name: "test.md",
    });

    const paras = doc.blocks.filter((b) => b.type === "paragraph");
    expect(paras.length).toBe(2);
    expect(paras[0].text).toBe("First paragraph.");
    expect(paras[1].text).toBe("Second paragraph.");
  });

  it("extracts code blocks", async () => {
    const md = "```\nconst x = 1;\n```";
    const doc = await markdownAdapter.load(makeFile(md), {
      id: "test-code",
      name: "test.md",
    });

    const code = doc.blocks.filter((b) => b.type === "code");
    expect(code.length).toBe(1);
    expect(code[0].text).toContain("const x = 1;");
  });

  it("does not include markdown syntax in spoken text", async () => {
    const md = "# Title\n\n**Bold** and *italic* text.";
    const doc = await markdownAdapter.load(makeFile(md), {
      id: "test-syntax",
      name: "test.md",
    });

    const allText = doc.blocks.map((b) => b.text).join(" ");
    // Should not contain #, **, or * as syntax markers
    expect(allText).not.toMatch(/^#/);
    expect(allText).not.toContain("**");
  });

  it("builds TOC from headings", async () => {
    const md =
      "# Chapter 1\n\nText.\n\n## Section 1.1\n\nMore text.\n\n# Chapter 2\n\nText.";
    const doc = await markdownAdapter.load(makeFile(md), {
      id: "test-toc",
      name: "test.md",
    });

    expect(doc.toc).toBeDefined();
    expect(doc.toc!.length).toBe(3); // 2 h1 + 1 h2
    expect(doc.toc![0].label).toBe("Chapter 1");
    expect(doc.toc![0].depth).toBe(0);
    expect(doc.toc![1].label).toBe("Section 1.1");
    expect(doc.toc![1].depth).toBe(1);
  });

  it("throws on empty markdown", async () => {
    const file = makeFile("   ");
    await expect(
      markdownAdapter.load(file, { id: "test-empty", name: "empty.md" }),
    ).rejects.toThrow("No se ha encontrado texto legible");
  });

  it("sets correct reading order", async () => {
    const md = "A\n\nB\n\nC";
    const doc = await markdownAdapter.load(makeFile(md), {
      id: "test-order",
      name: "test.md",
    });

    expect(doc.blocks[0].order).toBe(0);
    expect(doc.blocks[1].order).toBe(1);
    expect(doc.blocks[2].order).toBe(2);
  });
});
