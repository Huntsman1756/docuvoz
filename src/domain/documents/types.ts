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
  | "quote"
  | "separator"
  | "unknown";

/** Bounding box in PDF user space: [x0, y0, x1, y1], origin top-left. */
export type BBox = readonly [number, number, number, number];

export interface DocumentBlock {
  /** Stable id, unique within a document. Format `b<index>`. */
  id: string;
  type: BlockType;
  /** Text exactly as extracted. Never mutated by the spoken pipeline. */
  text: string;
  /** 1-based page number (PDF) or 1-based section index (other formats). */
  page: number;
  /** Reading order position within the document (0-based). */
  order: number;
  /** Heading depth (1-based) when applicable. */
  level?: number;
  /** List nesting depth (0-based) when applicable. */
  listLevel?: number;
  /** 0-based section/spine index for format-level navigation. */
  sectionIndex?: number;
  /**
   * Stable format-specific source reference, preserved from extraction:
   * EPUB `OEBPS/chap1.xhtml#p3`, Markdown/TXT `L<start>-L<end>` lines,
   * HTML/DOCX a normalized DOM/block path. Never shown to end users, but
   * it must survive into CanonicalDocument so UI content can always be
   * mapped back to the extracted source block.
   */
  sourceRef?: string;
  /**
   * EPUBCFI of the containing spine document when the format provides one
   * (EPUB via foliate-js). Never rendered; kept for source mapping.
   */
  sourceCfi?: string;
  bbox?: BBox;
}

export interface DocumentSource {
  name: string;
  /** Author when the format carries it (EPUB metadata, DOCX core props). */
  author?: string;
  /** SHA-256 hex of the original bytes when available. */
  sha256?: string;
  pageCount?: number;
  /** Language tag; Phase 0 targets `es`. */
  language: string;
}

/** Table-of-contents entry for chapter/section navigation. */
export interface TocEntry {
  /** Display label for the TOC entry. */
  label: string;
  /** Depth in the TOC hierarchy (0-based). */
  depth: number;
  /** 0-based index of the first block belonging to this entry. */
  blockIndex: number;
  /** Nested sub-entries. */
  subitems?: TocEntry[];
}

export interface StructuredDocument {
  id: string;
  source: DocumentSource;
  blocks: DocumentBlock[];
  /** Which adapter produced this document. */
  parser: string;
  /** Adapter version, part of extraction provenance. */
  parserVersion: string;
  /** Table of contents for navigation (optional; PDF may not have one). */
  toc?: TocEntry[];
  /** Page progression direction for RTL languages. */
  dir?: "ltr" | "rtl";
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
