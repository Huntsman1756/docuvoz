import type { DocumentBlock, StructuredDocument } from "@/domain/documents/types";
import { LAYOUT_NOISE_TYPES } from "@/domain/documents/types";
import { validateFidelity } from "@/domain/spoken/fidelity";
import { isPageNumberText, normalizeChromeKey } from "@/domain/spoken/layout-noise";
import { buildSpokenPlan } from "@/domain/spoken/pipeline";
import type { SpokenMode } from "@/domain/spoken/types";

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
  const blocks = doc.blocks.map((block) => {
    if (omissionIsSafe(block, doc)) return { ...block, type: "page-footer" as const };
    return LAYOUT_NOISE_TYPES.has(block.type)
      ? { ...block, type: "paragraph" as const }
      : block;
  });
  return buildSpokenPlan({ ...doc, blocks }, mode, { detectChrome: false });
}
