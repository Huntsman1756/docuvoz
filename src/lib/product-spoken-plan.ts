import type { DocumentBlock, StructuredDocument } from "@/domain/documents/types";
import { LAYOUT_NOISE_TYPES } from "@/domain/documents/types";
import { validateFidelity } from "@/domain/spoken/fidelity";
import { isPageNumberText, normalizeChromeKey } from "@/domain/spoken/layout-noise";
import { buildSpokenPlan } from "@/domain/spoken/pipeline";
import type { SpokenMode } from "@/domain/spoken/types";
import { parseTableFromBlocks, speakTable } from "@/domain/spoken/table-speech";

/** Product omission policy. Repetition alone never authorizes silence.
 * Literal validation is necessary but not sufficient: unknown prose is kept.
 * Research callers continue using the frozen pipeline directly. */
export function omissionIsSafe(block: DocumentBlock, doc: StructuredDocument): boolean {
  if (block.type === "page-number" && isPageNumberText(block.text)) return true;
  if (/^[\s—–_*=·•-]+$/.test(block.text)) return true;
  if (!validateFidelity(block.text, "", []).ok) return false;
  const key = normalizeChromeKey(block.text);
  const running = block.type === "page-header" || block.type === "page-footer";
  // Explicitly recognizable chrome only. Even classified headers can contain
  // obligations; a successful literal check cannot establish their semantics.
  const knownChrome =
    /^(boletín oficial del estado|encabezado repetido|pie de página|documento oficial)$/i.test(
      key,
    );
  return (
    running &&
    knownChrome &&
    new Set(
      doc.blocks
        .filter((b) => b.type === block.type && normalizeChromeKey(b.text) === key)
        .map((b) => b.page),
    ).size >= 3
  );
}

export function buildProductSpokenPlan(doc: StructuredDocument, mode: SpokenMode) {
  if (mode === "literal") return buildSpokenPlan(doc, mode);

  // Pre-process blocks: handle tables and footnotes specially
  const processedBlocks: DocumentBlock[] = [];
  let i = 0;

  // Collect footnotes for later insertion
  const footnotes: DocumentBlock[] = [];
  const footnoteMap = new Map<string, DocumentBlock>();

  // First pass: collect footnotes
  for (const block of doc.blocks) {
    if (block.type === "footnote") {
      footnotes.push(block);
      // Create a simple key based on footnote text or number
      const match = block.text.match(/^(\d+)/);
      if (match) {
        footnoteMap.set(match[1], block);
      }
    }
  }

  // Second pass: process blocks
  while (i < doc.blocks.length) {
    const block = doc.blocks[i];

    // Skip footnotes in the main flow (they'll be inserted at the end of paragraphs)
    if (block.type === "footnote") {
      i++;
      continue;
    }

    // Check if this is the start of a table
    if (block.type === "table-cell") {
      const tableResult = parseTableFromBlocks(doc.blocks, i);
      if (tableResult) {
        const { table, endIndex } = tableResult;

        // Create a synthetic paragraph with the spoken table text
        const spokenText = speakTable(table);
        if (spokenText) {
          // Use the first block's ID as the base for provenance
          processedBlocks.push({
            id: block.id, // Keep original ID for provenance
            type: "paragraph",
            text: spokenText,
            page: block.page,
            order: block.order,
            sectionIndex: block.sectionIndex,
            sourceRef: block.sourceRef,
            sourceCfi: block.sourceCfi,
            bbox: block.bbox,
          });
        }

        // Skip the table cells
        i = endIndex;
        continue;
      }
    }

    // Process other blocks normally
    if (omissionIsSafe(block, doc)) {
      processedBlocks.push({ ...block, type: "page-footer" as const });
    } else if (LAYOUT_NOISE_TYPES.has(block.type)) {
      processedBlocks.push({ ...block, type: "paragraph" as const });
    } else {
      // Check if this paragraph contains footnote references
      const footnoteRefs = block.text.match(/\[(\d+)\]/g);
      if (footnoteRefs && footnoteRefs.length > 0) {
        // Create a version with footnote content appended
        let enhancedText = block.text;
        for (const ref of footnoteRefs) {
          const num = ref.replace(/[\[\]]/g, "");
          const footnote = footnoteMap.get(num);
          if (footnote) {
            // Append footnote text after the reference
            enhancedText += ` Nota ${num}: ${footnote.text}`;
          }
        }
        processedBlocks.push({
          ...block,
          text: enhancedText,
        });
      } else {
        processedBlocks.push(block);
      }
    }

    i++;
  }

  return buildSpokenPlan({ ...doc, blocks: processedBlocks }, mode, {
    detectChrome: false,
  });
}
