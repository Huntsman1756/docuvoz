# ADR-005: Span-level provenance for every spoken segment

- **Status:** accepted
- **Date:** 2026-09-01

## Context

A listening product for legal/financial documents is worthless for
verification if a listener cannot answer "where in the document is this?".
Provenance also constrains honesty: claims about the transformation must be
supported by what we can actually trace.

## Decision

Every `SpokenSegment` carries `SegmentProvenance`
(`src/domain/provenance/provenance.ts`) from the start:

- `documentId` (+ source `sha256` at document level),
- ordered `blockIds` (source blocks; never empty),
- `pages[]` (1-based) and union `bbox` when the extractor provides geometry,
- character range over concatenated source block text,
- plus, on the segment itself: exact `sourceText`, generated spoken `text`,
  ordered `transformations[]` (`ruleId`, consumed source substring, emitted
  replacement) and fidelity outcome (`fidelityOk`, `fallbackApplied`, `muted`).

Spoken segments map 1:1 to blocks in Phase 0; the model allows n:1
(chunks merge several segments for synthesis while each keeps its own
provenance — see `SpeechChunk.segmentIds`).

The UI exposes this directly: selecting a segment shows source vs spoken text,
each transformation, page/bbox/blocks; muted noise is shown, never deleted.

Three properties are kept **separate** in types, docs and UI copy:

- **TRACEABLE** — provenance exists (guaranteed),
- **PRESERVED** — critical literals survive (machine-checked),
- **SEMANTICALLY FAITHFUL** — meaning survives (human gates only).

We never claim the third from the existence of the first two.

## Consequences

- (+) Auditability per sentence; UI highlighting and "play from here" reuse
  the same links.
- (+) Bug reports can quote `documentId:blockId` instead of the document.
- (−) Provenance bookkeeping adds pipeline ceremony (accepted cost).
- (−) bbox is only meaningful for native PDFs; scanned/reference inputs may
  lack geometry — fields are optional and typed as such.
