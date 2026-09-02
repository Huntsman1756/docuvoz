# Phase 0 — objective, gates and status

Phase 0 is an **engineering laboratory** that decides whether the product
hypothesis is technically and experientially valid. It is _not_ a polished
consumer app. The repository must make each question below answerable by a
repeatable command or a scripted human protocol.

## Hypothesis

> Documents are written to be seen, not heard. A deterministic spoken
> representation can make difficult documents significantly easier to
> understand while listening, without changing their meaning.

Three strictly separated modes:

| Mode            | Method                         | Rewrites meaning?     | In MVP            |
| --------------- | ------------------------------ | --------------------- | ----------------- |
| **Literal**     | read source verbatim           | no                    | yes               |
| **Listen**      | deterministic rules engine     | **never**             | yes               |
| **Manual Gold** | human-authored upper bound     | n/a (experiment only) | yes, corpus only  |
| **Adapted**     | LLM rewriting, explicit opt-in | may                   | **no** (deferred) |

Adapted is architecturally anticipated but **not implemented**; Listen must
never borrow from it.

## Gates and decision criteria

Each gate has a machine- or human-collectible evidence artifact.

### G1 — TTS latency

_Question:_ is latency acceptable for interactive web validation?

_Evidence:_ `npm run eval:tts:live` → `evaluation/results/tts.json` (request
latency p50/p95, time-to-playable, cache ratio). Measured against the real
provider, never assumed. With `mock` the pipeline is exercised but G1 is
**not** satisfied (a mock is not a network).

_Status:_ ⏳ awaiting credentials (see `docs/providers.md`).

### G2 — Extraction

_Question:_ does browser/local extraction preserve enough structure vs the
reference parser?

_Evidence:_ `npm run eval:extraction` → `evaluation/results/extraction.json`
compares browser (pdf.js) extraction against reference (Docling-shaped) JSON:
block recovery, heading/list/table/footnote classification, page assignment,
reading-order and chrome detection.

_Status:_ ✅ measured on synthetic corpus. Two-column and real-table handling
is the known weak spot (browser extractor does not detect tables). See
"Interpretation" below for the caveat that our reference is a _synthetic
Docling-shaped export_, not a live Docling run.

### G3a — Product hypothesis (human)

_Question:_ does a manually optimized spoken version clearly beat Literal?

_Protocol:_ for a corpus document with a `gold` file, listen to Literal vs
Manual Gold (both available in the UI) and record a preference + notes in
`evaluation/results/g3a.csv` (copy `evaluation/results/g3a.example.csv`).

_Decision:_ if Manual Gold is **not** clearly better → **STOP**. Do not
continue building a complex product.

### G3b — Automation viability (human + metric)

_Question:_ does deterministic Listen retain a meaningful portion of Manual
Gold's benefit?

_Evidence:_ `npm run eval:spoken` reports the segment-level agreement between
Listen and Manual Gold (`evaluation/results/spoken.json` → `goldAgreement`),
then human A/B confirmation (Literal vs Listen, Listen vs Gold) in
`evaluation/results/g3b.csv`.

_Status:_ ⏳ numbers are produced; the human A/B is pending for the real
single-user loop.

### G4 — Fidelity

_Question:_ does Listen preserve critical regulatory meaning on the corpus?

_Evidence:_ `npm run eval:fidelity` → `evaluation/results/fidelity.json`:
every critical literal (numbers, dates, monetary tokens, legal references,
identifiers, obligations/negations/exceptions/conditions/deadlines) must be
PRESERVED (verbatim or value-preserving-coverage) or the segment must have
fallen back to literal. **Any unsafe transformation blocks progression.**

_Status:_ ✅ passes on the synthetic corpus (`rejected` segments fall back
safely by design; the gate asserts no _silent_ loss).

## Interpretation limits (read before trusting a green gate)

- **TRACEABLE ≠ PRESERVED ≠ SEMANTICALLY FAITHFUL.** G4 proves _preserved_
  (literals survive). Only G3a/G3b humans speak to _faithful listening_. No
  automated gate claims semantic correctness.
- The reference extraction currently shipped is a **Docling-shaped synthetic
  export** produced by the fixture generator (`scripts/generate-fixture-pdfs.mjs`),
  because fixtures are synthetic and there is no copyrighted PDF to run real
  Docling on inside the repo. To benchmark real Docling on your own legally-held
  PDFs, see `evaluation/corpus/README.md` — G2 on real documents is an
  explicit open step, not a passed gate.
- The corpus is intentionally small and synthetic. It exercises the machinery
  and surfaces edge cases; it does not establish statistical confidence.

## Anti-goals

Phase 0 explicitly does **not** build: accounts, billing, mobile apps, cloud
library/sync, RAG, chat/Q&A, production auth, or the Adapted mode. The project
must stay easy to understand and easy to delete if the hypothesis fails.
