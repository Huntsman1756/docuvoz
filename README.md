# AUIDIO NAN — document-to-audio reading laboratory

**Status: Phase 0 research prototype.** Not a product, not a hosted service.
License: [MIT](LICENSE)

## What this is

A web-first engineering laboratory for one hypothesis:

> Documents are written to be seen, not heard. A **deterministic spoken
> representation** can make difficult documents significantly easier to
> understand while listening — without changing their meaning.

Phase 0 targets **Spanish financial and regulatory documents** (BOE, CNMV,
Banco de España, EUR-Lex style text): articles, nested numbering, deadlines,
percentages, EUR amounts, basis points, ISIN/LEI codes, T+2 settlement.

## What this is NOT

- **Not** a generic TTS reader — the transformation layer is the product idea.
- **Not** an LLM summarizer. There is no semantic rewriting anywhere.
- **Not** production infrastructure: the NaN/Kokoro API is wired in purely as
  **development/validation infrastructure** behind a provider abstraction
  ([ADR-002](docs/decisions/ADR-002-nan-is-validation-infrastructure.md),
  [docs/providers.md](docs/providers.md)).
- **Not** a finished app: the UI is a laboratory instrument, deliberately plain.

## Three modes (and one that does not exist yet)

| Mode            | Engine              | Guarantees                                                                                                                                                                                                            |
| --------------- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Literal**     | none                | reads the document verbatim (baseline)                                                                                                                                                                                |
| **Listen**      | deterministic rules | verbalizes numbers/dates/money/legal refs, mutes page chrome, **never** rewrites meaning; every transformation fidelity-validated with safe fallback ([ADR-004](docs/decisions/ADR-004-deterministic-listen-mode.md)) |
| **Manual Gold** | human hands         | manually authored spoken text used _only_ as the experimental upper bound (gate G3a)                                                                                                                                  |
| ~~Adapted~~     | LLM                 | **intentionally not implemented**; architecture reserves the slot, opt-in and separated from Listen                                                                                                                   |

The experiment measures Literal → Manual Gold (how much improvement exists)
and Manual Gold → Listen (how much the rules engine captures).

## Every spoken word is traceable

Each spoken segment carries span-level provenance — document, page, block ids,
bbox, exact source text, every applied rule and its inputs/outputs
([ADR-005](docs/decisions/ADR-005-span-level-provenance.md)). We keep three
properties strictly separate and never claim more than we verify:
**TRACEABLE** (provenance exists) ≠ **PRESERVED** (critical literals survive,
machine-checked) ≠ **SEMANTICALLY FAITHFUL** (humans must judge).

## Privacy by construction

The PDF never leaves the browser: parsing happens locally with pdf.js. Only
short, already-normalized _spoken chunks_ go to your own server endpoint, and
only from there onward to the configured TTS provider. With the default
`mock` provider, **no network at all**. Full details:
[docs/privacy.md](docs/privacy.md).

## Quick start

Requires Node ≥ 20.9. npm is the only supported package manager.

```bash
git clone <this-repo>
cd auidionan
npm ci
cp .env.example .env.local     # works as-is: provider=mock, no credentials needed
npm run dev                    # http://localhost:3000
```

Then click a corpus chip (e.g. **"Circular ficticia 1/2024"**), switch
between **Literal / Listen / Manual Gold**, press play, and click segments to
inspect source-vs-spoken text and provenance. Drop any native text PDF to
test it against your own documents (parsed locally, max 25 MB).

Real speech (Kokoro via NaN) is optional and opt-in — see
[docs/providers.md](docs/providers.md):

```bash
# .env.local
SPEECH_PROVIDER=nan
NAN_BASE_URL=https://<endpoint>/v1
NAN_API_KEY=<server-only; never reaches the browser>
```

## Commands

| Command                                       | What it does                                                          |
| --------------------------------------------- | --------------------------------------------------------------------- |
| `npm test`                                    | unit + golden + integration (mock provider, offline)                  |
| `npm run lint` / `typecheck` / `format:check` | static checks                                                         |
| `npm run build`                               | production build                                                      |
| `npm run test:e2e`                            | Playwright critical-path tests (CI-safe, mock provider)               |
| `npm run fixtures`                            | regenerate the synthetic corpus (PDFs + reference JSON + gold)        |
| `npm run eval:extraction`                     | synthetic smoke test for extraction (does **not** close G2)           |
| `npm run eval:spoken`                         | engine activity + Listen-vs-Gold engineering regression metric        |
| `npm run eval:fidelity`                       | G4a: critical-literal preservation; **fails the build on violations** |
| `npm run eval:tts:live`                       | G1: real provider measurement (requires credentials, refuses mock)    |
| `npm run eval:tts:wiring`                     | offline wiring smoke for the G1 harness (never G1 evidence)           |
| `npm run g3a:prepare`                         | build the G3a blind listening kit (audio needs real credentials)      |
| `npm run g4b:packet`                          | build the G4b human semantic-fidelity review packet                   |
| `npm run test:provider:live`                  | opt-in live NaN wiring check (local only)                             |

## Phase 0 status

Two different claims, never conflated: **the laboratory is built** and
**the hypothesis is validated**. Only the first is true today. Canonical
table in [docs/phase-0.md](docs/phase-0.md):

```text
PHASE_0_INFRASTRUCTURE        = PASS   builds/tests/gates runnable offline
G1_TTS_LIVE                   = PASS   NaN live 15rpm: 12/12 ok, TTFA p95 1.63s, 0×429 (tts.json)
G2_EXTRACTION_REAL            = OPEN   synthetic smoke only (tables 0/2, footnote 0/1)
G3A_PRODUCT_HYPOTHESIS        = OPEN   blind protocol prepared, ears required
G3B_AUTOMATION_PROXY          = PASS   word-level Dice 0.945 — 8-entry gold set, 2026-09-02
G3B_HUMAN                     = OPEN   capture-ratio protocol prepared (Literal/Gold/Listen)
G4A_CRITICAL_LITERAL_PRESERV. = PASS   0 violations, 0 silent losses (machine-verified)
G4B_SEMANTIC_FIDELITY         = PASS   32/32 human verdicts post-fix — reviewed corpus ONLY
PRODUCT_GO_NO_GO              = NOT_DECIDED
```

A green CI run proves the experiment machinery works. It is not evidence
that documents are easier to understand when heard — that is what G3a/G3b
humans exist to decide.

## Architecture (tour)

```text
src/
  domain/           pure logic: documents, spoken rules + fidelity, speech
                    contract, provenance          (no framework, no I/O)
  adapters/         document-parsers (pdf.js) · speech-providers (nan, mock, pacing)
  infrastructure/   audio cache keys, filesystem cache, structured logging
  server/           env validation, rate limiting, framework-agnostic handler
  app/              Next.js routes (thin wrappers) + laboratory UI
tests/              unit · golden · integration · e2e · fixtures
evaluation/         corpus docs, eval scripts, machine-readable results
docs/               architecture, models, privacy, providers, ADRs
```

Deep dive: [docs/architecture.md](docs/architecture.md) ·
[docs/document-model.md](docs/document-model.md) ·
[docs/spoken-representation.md](docs/spoken-representation.md)

## Limitations (honest list)

- Browser extraction does not detect **tables** or **two-column** reading
  order, and cannot read **scanned** PDFs (no text layer). Measured, not
  hidden: `evaluation/results/extraction.json`.
- The committed corpus is **synthetic**; "reference" extractions are
  Docling-shaped idealizations, not live Docling runs. Instructions for
  benchmarking real Docling on legally-held PDFs:
  [evaluation/corpus/README.md](evaluation/corpus/README.md).
- Listen covers the initial Spanish regulatory rule set; coverage gaps
  surface as **fidelity fallbacks** (safe, but literal-sounding audio).
- Rate limiting/cache state are in-memory + single-process: **do not deploy
  publicly** as-is, and never assume a personal API key grants third-party
  serving rights.
- No Adapted mode, no accounts, no mobile. On purpose.
- **Legal note:** this project reads documents aloud; it is not legal or
  financial advice, and no automated check certifies semantic faithfulness.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md) (especially the golden-rule loop and
the regression-fixture policy), then open an issue or PR.
Security reports: [SECURITY.md](SECURITY.md). Community: [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
History: [CHANGELOG.md](CHANGELOG.md).

## License

MIT — see [LICENSE](LICENSE). Third-party runtime components (pdf.js, Next.js,
React, JSZip, Mammoth, DOMPurify, markdown-it, `idb`, `zod`) and the vendored
foliate-js EPUB parser are permissively licensed; the full inventory and
vendoring provenance live in
[docs/third-party-notices.md](docs/third-party-notices.md). Model weights and
audio from real providers are governed by **their** terms, not this license.
Generated
TTS audio is **not** redistributed in this repository: the G3a experiment
commits the blinded manifest with per-clip SHA-256 (stimulus identity) while
the WAV binaries stay in the private experimental kit pending confirmation of
redistribution rights from the TTS provider.
