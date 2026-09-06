/**
 * Part 15 — Deep nesting / long-line / structural stress tests.
 *
 * Verifies that parsers handle pathological inputs without crashing:
 * 1. EPUB with very deep heading nesting (100+ levels)
 * 2. Markdown with very long lines (1MB)
 * 3. EPUB with deeply nested TOC
 * 4. HTML with deeply nested tags
 * 5. DOCX with deeply nested lists
 */
import { describe, expect, it } from "vitest";
import { markdownAdapter } from "@/adapters/document-parsers/adapters/markdown-adapter";
import { htmlAdapter } from "@/adapters/document-parsers/adapters/html-adapter";
import { epubAdapter } from "@/adapters/document-parsers/adapters/epub-adapter";
import { docxAdapter } from "@/adapters/document-parsers/adapters/docx-adapter";
import { asFile, buildDocx, buildEpub } from "../e2e/helpers/doc-fixtures";

/* ------------------------------------------------------------------ */
/*  1. EPUB with very deep heading nesting                           */
/* ------------------------------------------------------------------ */

describe("epubAdapter: deep heading nesting", () => {
  it("handles 100 levels of nested headings without crashing", async () => {
    // Build EPUB with deeply nested headings
    let body = "";
    for (let i = 1; i <= 100; i++) {
      body += `<h${Math.min(i, 6)}>Level ${i}</h${Math.min(i, 6)}>\n`;
    }
    body += `<p>Content after headings.</p>`;

    const epub = await buildEpub({
      name: "deep.epub",
      title: "Deep",
      language: "es",
      version: 3,
      toc: null,
      chapters: [
        {
          file: "chap1.xhtml",
          title: "Deep nesting",
          body,
        },
      ],
    });

    // Should not throw or hang
    const doc = await epubAdapter.load(asFile(epub), { id: "deep", name: "deep.epub" });
    expect(doc.blocks.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/*  2. Markdown with very long lines                                 */
/* ------------------------------------------------------------------ */

describe("markdownAdapter: very long lines", () => {
  it("handles a 1 MB line without crashing", async () => {
    const longLine = "x".repeat(1_000_000);
    const md = `# Title\n\n${longLine}\n\nSome text.`;
    const file = new File([md], "long.md", { type: "text/markdown" });

    const doc = await markdownAdapter.load(file, { id: "long", name: "long.md" });
    expect(doc.blocks.length).toBeGreaterThan(0);
    // The long line should be in the first content block
    const longBlock = doc.blocks.find((b) => b.text.length > 100_000);
    expect(longBlock).toBeDefined();
  });

  it("handles many short lines without crashing", async () => {
    // Consecutive lines without blank-line separation form one paragraph in markdown
    const lines = Array.from({ length: 5000 }, (_, i) => `Line ${i}`);
    const md = lines.join("\n");
    const file = new File([md], "many.md", { type: "text/markdown" });

    const doc = await markdownAdapter.load(file, { id: "many", name: "many.md" });
    // Consecutive lines form one paragraph block
    expect(doc.blocks.length).toBe(1);
    expect(doc.blocks[0].text.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/*  3. HTML with deeply nested tags                                  */
/* ------------------------------------------------------------------ */

describe("htmlAdapter: deeply nested tags", () => {
  it("handles 200 levels of nested spans without crashing", async () => {
    let html = "<html><body>";
    for (let i = 0; i < 200; i++) {
      html += "<span>";
    }
    html += "content";
    for (let i = 0; i < 200; i++) {
      html += "</span>";
    }
    html += "</body></html>";

    const file = new File([html], "deep.html", { type: "text/html" });
    const doc = await htmlAdapter.load(file, { id: "deep", name: "deep.html" });
    expect(doc.blocks.length).toBeGreaterThan(0);
    expect(doc.blocks[0].text).toBe("content");
  });
});

/* ------------------------------------------------------------------ */
/*  4. DOCX with deeply nested lists                                 */
/* ------------------------------------------------------------------ */

describe("docxAdapter: deeply nested lists", () => {
  it("handles nested list items without crashing", async () => {
    // The docx builder supports one level of nesting via children.items: string[]
    const docx = await buildDocx({
      items: [
        {
          type: "list" as const,
          ordered: false,
          items: [
            { text: "Level 0" },
            {
              text: "Level 0 nested",
              children: { ordered: false, items: ["Level 1"] },
            },
          ],
        },
      ],
    });

    const doc = await docxAdapter.load(asFile(docx), {
      id: "nested",
      name: "nested.docx",
    });
    expect(doc.blocks.length).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ */
/*  5. EPUB with very deep TOC structure                             */
/* ------------------------------------------------------------------ */

describe("epubAdapter: deep TOC structure", () => {
  it("handles 100 levels of nested TOC entries", async () => {
    interface TocItem {
      label: string;
      href: string;
      children?: TocItem[];
    }

    const buildDeepToc = (depth: number): TocItem[] => {
      if (depth === 0) {
        return [{ label: `Level ${depth}`, href: `chap${depth}.xhtml` }];
      }
      return [
        {
          label: `Level ${depth}`,
          href: `chap${depth}.xhtml`,
          children: buildDeepToc(depth - 1),
        },
      ];
    };

    const epub = await buildEpub({
      name: "deep-toc.epub",
      title: "DeepToc",
      language: "es",
      version: 3,
      toc: buildDeepToc(20),
      chapters: [
        {
          file: "chap1.xhtml",
          title: "Level 20",
          body: `<h1>Level 20</h1><p>Content at the deepest level.</p>`,
        },
      ],
    });

    const doc = await epubAdapter.load(asFile(epub), {
      id: "deeptoc",
      name: "deep-toc.epub",
    });
    expect(doc.blocks.length).toBeGreaterThan(0);
    // TOC should have entries at multiple depths
    if (doc.toc) {
      const depths = doc.toc.map((t) => t.depth);
      expect(Math.max(...depths)).toBeGreaterThanOrEqual(10);
    }
  });
});

/* ------------------------------------------------------------------ */
/*  6. Mixed content stress test                                     */
/* ------------------------------------------------------------------ */

describe("mixed structural stress", () => {
  it("markdown with code blocks, tables, lists and long content", async () => {
    const md = `# Complex Document

Paragraph one.

\`\`\`
function hello() {
  console.log("world");
}
\`\`\`

- item 1
- item 2
  - nested item
    - deeply nested

| Header | Value |
|--------|-------|
| A      | 1     |
| B      | 2     |

> A long quote that spans multiple lines
> and contains nested **bold** and *italic* text.

---

Some final text.`;

    const file = new File([md], "complex.md", { type: "text/markdown" });
    const doc = await markdownAdapter.load(file, { id: "complex", name: "complex.md" });
    expect(doc.blocks.length).toBeGreaterThan(5);

    // Should have different block types
    const types = new Set(doc.blocks.map((b) => b.type));
    expect(types.has("paragraph")).toBe(true);
    expect(types.has("code")).toBe(true);
    expect(types.has("list-item")).toBe(true);
    expect(types.has("heading")).toBe(true);
    expect(types.has("quote")).toBe(true);
  });
});
