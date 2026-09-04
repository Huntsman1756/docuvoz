/**
 * Chapter derivation tests.
 *
 * Verifies that AudioChapters are correctly derived from document structure.
 */
import { describe, expect, it } from "vitest";
import { deriveChapters } from "@/lib/export/chapter";
import type { StructuredDocument } from "@/domain/documents/types";
import type { SpeechChunk } from "@/domain/spoken/types";

function makeDoc(blocks: StructuredDocument["blocks"]): StructuredDocument {
  return {
    id: "doc-test",
    source: { name: "test-document.pdf", language: "es", pageCount: 5 },
    blocks,
    parser: "test",
    parserVersion: "0.0.1",
  };
}

function makeChunks(texts: string[]): SpeechChunk[] {
  return texts.map((text, i) => ({
    id: `c${i}`,
    text,
    segmentIds: [`s${i}`],
  }));
}

describe("deriveChapters", () => {
  it("returns a single chapter when there are no headings", () => {
    const doc = makeDoc([
      { id: "b0", type: "paragraph", text: "Some text", page: 1, order: 0 },
      { id: "b1", type: "paragraph", text: "More text", page: 1, order: 1 },
    ]);
    const chunks = makeChunks(["Some text", "More text"]);
    const chapters = deriveChapters(doc, chunks);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("test-document");
    expect(chapters[0].startChunkIndex).toBe(0);
  });

  it("derives chapters from heading blocks", () => {
    const doc = makeDoc([
      {
        id: "b0",
        type: "heading",
        text: "Chapter 1: Introduction",
        page: 1,
        order: 0,
        level: 1,
      },
      { id: "b1", type: "paragraph", text: "First paragraph", page: 1, order: 1 },
      {
        id: "b2",
        type: "heading",
        text: "Chapter 2: Methods",
        page: 2,
        order: 2,
        level: 1,
      },
      { id: "b3", type: "paragraph", text: "Second paragraph", page: 2, order: 3 },
    ]);
    const chunks = makeChunks([
      "Chapter 1: Introduction, First paragraph",
      "Chapter 2: Methods, Second paragraph",
    ]);
    const chapters = deriveChapters(doc, chunks);
    expect(chapters.length).toBeGreaterThanOrEqual(2);
    expect(chapters[0].title).toBe("Chapter 1: Introduction");
    expect(chapters[0].startChunkIndex).toBe(0);
  });

  it("strips trailing colons from chapter titles", () => {
    const doc = makeDoc([
      { id: "b0", type: "heading", text: "Results:", page: 1, order: 0, level: 2 },
    ]);
    const chunks = makeChunks(["Results:"]);
    const chapters = deriveChapters(doc, chunks);
    expect(chapters[0].title).toBe("Results");
  });

  it("skips headings with empty text after trimming", () => {
    const doc = makeDoc([
      { id: "b0", type: "heading", text: ":::", page: 1, order: 0, level: 1 },
      { id: "b1", type: "paragraph", text: "Content", page: 1, order: 1 },
    ]);
    const chunks = makeChunks(["Content"]);
    const chapters = deriveChapters(doc, chunks);
    // Empty heading skipped, falls back to single chapter
    expect(chapters).toHaveLength(1);
    expect(chapters[0].startChunkIndex).toBe(0);
  });

  it("deduplicates chapters at the same chunk index", () => {
    const doc = makeDoc([
      { id: "b0", type: "heading", text: "Section A", page: 1, order: 0 },
      { id: "b1", type: "heading", text: "Section B", page: 1, order: 1 },
      { id: "b2", type: "paragraph", text: "Content", page: 1, order: 2 },
    ]);
    const chunks = makeChunks(["Section A Section B Content"]);
    const chapters = deriveChapters(doc, chunks);
    // Both headings map to chunk 0, only first should be kept
    expect(chapters).toHaveLength(1);
    expect(chapters[0].title).toBe("Section A");
  });

  it("returns a single chapter for documents with only non-heading blocks", () => {
    const doc = makeDoc([
      { id: "b0", type: "paragraph", text: "No structure here", page: 1, order: 0 },
    ]);
    const chunks = makeChunks(["No structure here"]);
    const chapters = deriveChapters(doc, chunks);
    expect(chapters).toHaveLength(1);
    expect(chapters[0].startChunkIndex).toBe(0);
  });
});
