# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The **spoken-representation engine** has its own version
(`SPOKEN_ENGINE_VERSION`) that is part of every audio cache key; engine rule
changes are listed under the same headings.

## [Unreleased]

### Changed

- **Engine `1.1.0`** (`SPOKEN_ENGINE_VERSION`, invalidates audio cache): the
  `legal-references` rule no longer destroys the sentence boundary after a
  heading citation (`"Artículo 1. Objeto."` → `"artículo uno. Objeto."`, was
  `"artículo unoObjeto."`) and keeps the plural in joint references
  (`"artículos 121 y 122"` → `"artículos ciento veintiuno y ciento veintidós"`,
  was `"artículo …"`). Both defects were found by the G4b human review
  (round 1 FAILs on `s4`, `s5`, `s11`, `ea:s8`); round 2 re-review passed and
  the untouched `golden:legal` row confirmed no regression.
- `G1_TTS_LIVE = PASS` and `G4B_SEMANTIC_FIDELITY = PASS` recorded with
  explicit, scope-limited meanings (`docs/phase-0.md`); G4b covers only the
  32 reviewed Phase-0 corpus rows, not arbitrary regulatory documents.
- **Gate vocabulary split (binding):** infrastructure status is now separate
  from validation status. `PHASE_0_INFRASTRUCTURE = PASS` no longer reads as
  Phase 0 completion; the decision state is `PRODUCT_GO_NO_GO = NOT_DECIDED`
  until every gate has real evidence (`docs/phase-0.md`).
- `G4` renamed to `G4A_CRITICAL_LITERAL_PRESERVATION`;
  `G4B_SEMANTIC_FIDELITY` introduced as a separate, human, no-LLM-judge
  gate.
- Listen-vs-Gold word-level Dice repositioned as `G3B_AUTOMATION_PROXY` — an
  engineering regression metric, explicitly not an experience proxy;
  `G3B_HUMAN` defined via the capture-ratio protocol.
- `eval:extraction` output labeled `G2-SMOKE`; the real gate is
  `G2_EXTRACTION_REAL = OPEN` until the five-document benchmark runs.
- `eval:tts:live` rewritten to measure per-request TTFA, wire latency,
  retries, pacing queue wait, audio duration, RTF and wire-level 429s over a
  stratified sample of real Listen chunks, with a sustained `--burn` mode;
  it maps only to the transport sub-gates `G1_PROVIDER_CONNECTIVITY`,
  `G1_PROVIDER_LATENCY`, `G1_PROVIDER_RATE_BEHAVIOR`.

### Added

- `npm run eval:tts:wiring` — offline self-test of the measurement harness
  writing to `results/tts.wiring-smoke.json`, clearly excluded from G1.
- `npm run g3a:prepare` — G3a blind listening kit: Literal-vs-Manual-Gold
  pairs from `nested-regulation-01` with seeded randomized blinded labels,
  answer sheet, objective comprehension questions and duration-balance
  report (`evaluation/experiments/g3a/PROTOCOL.md`). Condition key and audio
  are gitignored; mock audio is refused by design.
- `npm run g4b:packet` — deterministic source→spoken human review packet
  (`evaluation/experiments/g4b/`).
- Unit tests for the G3a pairing/blinding logic (`tests/unit/g3a-lib.test.ts`).

## [0.1.0] - 2026-09-02

First Phase 0 laboratory release.

### Added

- **Document pipeline**: browser-side PDF extraction (pdf.js) into a
  Docling-flavored structured block model with span-level provenance; corpus
  fixture pipeline with reference (desktop-parser-shaped) exports.
- **Spoken engine v1.0.0 (Listen mode)**: deterministic Spanish
  regulatory/financial normalization rules — legal references, nested
  numbering, dates, Spanish decimal conventions, percentages, EUR amounts,
  basis points, T+1/T+2 settlement, ISIN/LEI verbalization, acronym and
  abbreviation expansion, range/time handling, repeated page-chrome muting,
  heading prosody.
- **Fidelity safeguards**: critical-token detection (obligations, negations,
  exceptions, conditions, deadlines, numeric literals, identifiers) with
  PASS/REJECT validation and automatic fallback to literal text.
- **Speech stack**: provider abstraction (`SpeechProvider`), NaN/Kokoro
  adapter (validation infrastructure) plus deterministic mock provider,
  paced retries with backoff, server-side API with schema validation, rate
  limiting, filesystem cache, IndexedDB client cache, speech queue with
  bounded prefetch and latency/underrun metrics.
- **Web laboratory UI**: Literal vs Listen vs Manual Gold comparison,
  segment highlighting, provenance inspector, metrics panel.
- **Evaluation harness**: extraction (G2), spoken coverage, fidelity (G4) and
  TTS latency (G1) scripts producing machine-readable results.
- **Repository**: MIT license, CI (lint/typecheck/tests/build + npm audit),
  security and contribution docs, ADRs.

### Known limitations

- Tables, two-column and scanned layouts are not handled by browser
  extraction (measured, not hidden — see `evaluation/results/extraction.json`).
- Semantic faithfulness is _not_ machine-provable; it requires the human
  G3a/G3b listening experiments.
- The NaN provider adapter has not been exercised against a live endpoint in
  this environment (no credentials); wiring is covered by mocked tests and an
  opt-in live test.
