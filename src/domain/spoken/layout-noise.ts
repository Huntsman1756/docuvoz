import type { DocumentBlock, StructuredDocument } from "@/domain/documents/types";

/**
 * Repeated page chrome detection (headers/footers that carry no semantics).
 *
 * A block is treated as page chrome when its *exact* text (case and
 * whitespace normalized) repeats on at least 25% of pages (minimum 3) and
 * the block is short. Exactness is deliberate: normalizing digits would mute
 * body text like "Artículo 1." / "Artículo 2." across pages. Footers with
 * per-page numbers are handled by the parser's geometry classification
 * (page-footer / page-number), not by this detector. Real body text that
 * happens to repeat (boilerplate clauses) is longer than the cap and
 * survives. This is a heuristic — evaluation tracks its error rate.
 */

export function normalizeChromeKey(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function detectChromeBlocks(doc: StructuredDocument): Set<string> {
  const byKey = new Map<string, Map<number, DocumentBlock>>();
  for (const block of doc.blocks) {
    if (block.type === "page-header" || block.type === "page-footer") {
      continue; // already classified by the parser
    }
    const normalized = normalizeChromeKey(block.text);
    if (normalized.length === 0 || block.text.length > 120) continue;
    let pages = byKey.get(normalized);
    if (!pages) {
      pages = new Map();
      byKey.set(normalized, pages);
    }
    // Keep first occurrence per page only.
    if (!pages.has(block.page)) pages.set(block.page, block);
  }
  const chrome = new Set<string>();
  const pageCount = new Set(doc.blocks.map((b) => b.page)).size;
  const threshold = Math.max(3, Math.ceil(pageCount * 0.25));
  for (const pages of byKey.values()) {
    if (pages.size >= threshold) {
      for (const block of pages.values()) {
        // Never mute structural blocks.
        if (block.type === "heading" || block.type === "list-item") continue;
        chrome.add(block.id);
      }
    }
  }
  return chrome;
}

const PAGE_NUMBER_RE =
  /^\s*(?:p[aá]g\.?\s*)?\d{1,4}(?:\s*(?:de|\/|-|d[eé])\s*\d{1,4})?\s*$/i;

export function isPageNumberText(text: string): boolean {
  return PAGE_NUMBER_RE.test(text.trim());
}
