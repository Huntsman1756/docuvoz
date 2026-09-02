/**
 * Internal document representation.
 *
 * The shape is intentionally a pragmatic subset of the conceptual
 * `DoclingDocument` model (see docs/document-model.md and ADR-003): typed
 * blocks with provenance, reading order and hierarchy, but no full AST.
 * Parser-specific structures are adapted into this shape and never leak
 * beyond adapters.
 */

export type BlockType =
  | "paragraph"
  | "heading"
  | "list-item"
  | "table-cell"
  | "caption"
  | "footnote"
  | "formula"
  | "page-header"
  | "page-footer"
  | "page-number"
  | "code"
  | "unknown";

/** Bounding box in PDF user space: [x0, y0, x1, y1], origin top-left. */
export type BBox = readonly [number, number, number, number];

export interface DocumentBlock {
  /** Stable id, unique within a document. Format `b<index>`. */
  id: string;
  type: BlockType;
  /** Text exactly as extracted. Never mutated by the spoken pipeline. */
  text: string;
  /** 1-based page number. */
  page: number;
  /** Reading order position within the document (0-based). */
  order: number;
  /** Heading depth (1-based) when applicable. */
  level?: number;
  /** List nesting depth (0-based) when applicable. */
  listLevel?: number;
  bbox?: BBox;
}

export interface DocumentSource {
  name: string;
  /** SHA-256 hex of the original bytes when available. */
  sha256?: string;
  pageCount?: number;
  /** Language tag; Phase 0 targets `es`. */
  language: string;
}

export interface StructuredDocument {
  id: string;
  source: DocumentSource;
  blocks: DocumentBlock[];
  /** Which adapter produced this document. */
  parser: string;
  /** Adapter version, part of extraction provenance. */
  parserVersion: string;
}

/** Block types excluded from speech unless their content is critical. */
export const LAYOUT_NOISE_TYPES: ReadonlySet<BlockType> = new Set([
  "page-header",
  "page-footer",
  "page-number",
]);

export function blocksOf(
  doc: StructuredDocument,
  ...types: BlockType[]
): DocumentBlock[] {
  const set = new Set(types);
  return doc.blocks.filter((b) => set.has(b.type));
}
