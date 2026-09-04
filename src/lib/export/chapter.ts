/**
 * Chapter derivation from document structure.
 *
 * Uses PDF headings (block.type === "heading") as chapter boundaries.
 * Documents without headings get a single chapter spanning the whole document.
 */

import type { StructuredDocument } from "@/domain/documents/types";
import type { SpeechChunk } from "@/domain/spoken/types";
import type { AudioChapter } from "./types";

/**
 * Derive chapters from a structured document and its speech chunks.
 *
 * Algorithm:
 * 1. Find heading blocks in the document.
 * 2. Map each heading to the segment that contains it.
 * 3. Map each segment to the chunk that contains it.
 * 4. Each heading becomes a chapter boundary.
 *
 * For documents without headings, returns a single chapter.
 */
export function deriveChapters(
  doc: StructuredDocument,
  chunks: readonly SpeechChunk[],
): AudioChapter[] {
  const headings = doc.blocks.filter((b) => b.type === "heading");

  if (headings.length === 0) {
    // No headings → single chapter for the whole document
    return [
      {
        title: doc.source.name.replace(/\.[^.]+$/, ""),
        startChunkIndex: 0,
        startTime: 0,
      },
    ];
  }

  // Build a map: blockId → chunkIndex
  // We need to trace: heading block → segment → chunk
  // But segments are created during buildSpokenPlan, and we don't have them here.
  // Instead, we can use a simpler heuristic: headings appear in block order,
  // and chunks process blocks in order. We can find which chunk each heading's
  // text first appears in.

  const chapters: AudioChapter[] = [];

  for (const heading of headings) {
    const title = heading.text.replace(/[:.]+$/, "").trim();
    if (title.length === 0) continue;

    // Find the first chunk that contains text from this heading
    const chunkIndex = findChunkForBlock(heading, chunks);
    if (chunkIndex >= 0) {
      // Avoid duplicate chapters at the same chunk
      const last = chapters[chapters.length - 1];
      if (!last || last.startChunkIndex !== chunkIndex) {
        chapters.push({ title, startChunkIndex: chunkIndex, startTime: 0 });
      }
    }
  }

  // Ensure first chapter starts at 0
  if (chapters.length === 0 || chapters[0].startChunkIndex > 0) {
    chapters.unshift({
      title: doc.source.name.replace(/\.[^.]+$/, ""),
      startChunkIndex: 0,
      startTime: 0,
    });
  }

  return chapters;
}

/**
 * Find the first chunk index that contains text from a given block.
 * Uses a fuzzy substring match since chunks may have transformed text.
 */
function findChunkForBlock(
  block: { text: string; page: number },
  chunks: readonly SpeechChunk[],
): number {
  // Try exact match first (for Listen mode where text is transformed)
  // Fall back to checking if the block's first sentence appears in a chunk
  const needle = block.text.slice(0, 60).toLowerCase();

  for (let i = 0; i < chunks.length; i++) {
    const chunkText = chunks[i].text.toLowerCase();
    if (chunkText.includes(needle)) return i;
  }

  // Fallback: distribute chapters evenly based on page number
  // This is conservative — we'd rather have fewer chapters than wrong ones
  return -1;
}
