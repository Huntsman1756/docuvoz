# Document model

## Why this shape

We do **not** invent a full document AST. The conceptual reference is
`DoclingDocument` (Docling's layout-aware document representation). We adopt a
pragmatic subset — typed blocks in reading order with provenance — and adapt
every parser into it, so no parser-specific structure leaks into the domain.
See [ADR-003](decisions/ADR-003-docling-as-reference-model.md).

The open question in Phase 0 is not "can we beat Docling?" but:

> How much semantic structure do we lose moving from a strong desktop
> reference parser to something usable interactively in the browser?

That is why there are two extraction paths producing the _same_
`StructuredDocument` type:

- **Reference** (`parser: "docling-reference-export"`): a high-quality
  desktop-grade representation. In this repo it is a synthetic export emitted
  by the fixture generator so it can ship legally; for real PDFs you can plug
  a genuine Docling run here.
- **Browser** (`parser: "pdfjs-browser"`): what pdf.js + `build-document.ts`
  can recover client-side from native PDFs.

The evaluation harness diffs them (gate G2).

## Types

`src/domain/documents/types.ts`:

```ts
type BlockType =
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

interface DocumentBlock {
  id: string; // `b<index>`, unique within a document
  type: BlockType;
  text: string; // exactly as extracted; never mutated downstream
  page: number; // 1-based
  order: number; // reading order, 0-based, monotonic across pages
  level?: number; // heading depth (1-based)
  listLevel?: number; // list nesting (0-based)
  bbox?: [x0, y0, x1, y1]; // PDF user space, top-left origin
}

interface StructuredDocument {
  id: string;
  source: { name: string; sha256?: string; pageCount?: number; language: string };
  blocks: DocumentBlock[];
  parser: string; // which adapter produced it
  parserVersion: string; // part of extraction provenance
}
```

`LAYOUT_NOISE_TYPES` = `page-header | page-footer | page-number`. These are
kept in Literal and muted (never deleted) in Listen.

## Browser extraction heuristics

`src/adapters/document-parsers/build-document.ts` (pure; runs identically in
tests under Node and in the browser):

- **Line grouping:** text items sorted by baseline, clustered within a vertical
  tolerance; horizontal gaps insert spaces.
- **Blocks:** split on vertical gaps, left-margin jumps, font-size changes,
  list/non-list transitions and header/body/footer band changes.
- **Heading:** ≤ 2 lines with glyph height above the modal body size.
- **Footnote:** glyph height well below body size near the page bottom.
- **Page header/footer:** small-print lines in the top/bottom 10% bands.
- **Page number:** a footer that is only digits / "página N" / "N de M".
- **Table:** **not detected** in the browser path (recorded as a G2 gap).

Two-column layouts are read in geometric order, which may interleave columns;
this is measured, not hidden.

## Provenance model

`src/domain/provenance/provenance.ts`. Every `SpokenSegment` carries:

```ts
interface SegmentProvenance {
  documentId: string;
  blockIds: string[]; // source blocks, reading order (never empty)
  pages: number[]; // 1-based pages involved
  bbox?: [x0, y0, x1, y1]; // union of block boxes when available
  sourceStart?: number; // char range over concatenated source text
  sourceEnd?: number;
}
```

Three properties are **kept distinct** and must never be conflated:

1. **TRACEABLE** — provenance exists (machine-guaranteed here).
2. **PRESERVED** — critical literals survive the transformation
   (machine-checked by the fidelity validator).
3. **SEMANTICALLY FAITHFUL** — meaning survives (human judgment only).

See [ADR-005](decisions/ADR-005-span-level-provenance.md).

## Adding a parser adapter

Implement a function `YourInput -> StructuredDocument` in
`src/adapters/document-parsers/`, set `parser`/`parserVersion`, and add an
extraction integration test. The domain and UI are unchanged; the G2 eval can
then compare your adapter against the reference automatically.
