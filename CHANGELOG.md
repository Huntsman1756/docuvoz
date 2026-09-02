# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

The **spoken-representation engine** has its own version
(`SPOKEN_ENGINE_VERSION`) that is part of every audio cache key; engine rule
changes are listed under the same headings.

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
