# ADR-003: Docling-shaped document model as reference representation

- **Status:** accepted
- **Date:** 2026-09-01

## Context

Structured extraction is a solved-ish problem in desktop tooling (Docling,
Marker, MinerU) and unsolved in the browser. Inventing a bespoke AST is
unjustified; coupling the app to one parser's full object graph is equally
unwise.

## Decision

Adopt a pragmatic subset of `DoclingDocument` as the internal
`StructuredDocument`: typed blocks (paragraph, heading, list-item, table-cell,
caption, footnote, page-header/footer/number, …) in reading order with page,
bbox and `parser`/`parserVersion` provenance (`src/domain/documents/types.ts`).

- Every parser (browser pdf.js; reference exports; future adapters) maps into
  this shape. Nothing parser-specific crosses the adapter boundary.
- "Reference extraction" in-repo is a **Docling-shaped synthetic export**
  emitted by the fixture generator, representing the ideal structure that
  produced each synthetic PDF. For legally-held real PDFs, contributors can
  run real Docling and export into the same shape (documented workflow in
  `evaluation/corpus/README.md`).

## Consequences

- (+) G2 becomes a like-for-like diff between extraction tiers.
- (+) Swapping/upgrading parsers is an adapter-level change.
- (−) We do not model full Docling richness (formula semantics, merged table
  cells, inline span styles). If evidence shows the flat-block model is the
  bottleneck, revisit — deliberately _after_ measurement, not before.
- (−) The synthetic "reference" is idealized (upper bound). G2 numbers on
  synthetic fixtures overstate what real desktop parsers must recover from
  messy PDFs; they measure _browser pipeline loss_, not Docling quality.
