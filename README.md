# AUIDIO NAN — document-to-audio reading laboratory

**Status: Phase 0 research prototype.** Not a product, not a hosted service.
CI: [![CI](https://github.com/auidionan/auidionan/actions/workflows/ci.yml/badge.svg)](https://github.com/auidionan/auidionan/actions/workflows/ci.yml)
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

| Command                                       | What it does                                                         |
| --------------------------------------------- | -------------------------------------------------------------------- |
| `npm test`                                    | unit + golden + integration (mock provider, offline)                 |
| `npm run lint` / `typecheck` / `format:check` | static checks                                                        |
| `npm run build`                               | production build                                                     |
| `npm run test:e2e`                            | Playwright critical-path tests (CI-safe, mock provider)              |
| `npm run fixtures`                            | regenerate the synthetic corpus (PDFs + reference JSON + gold)       |
| `npm run eval:extraction`                     | G2: browser extraction vs reference structure                        |
| `npm run eval:spoken`                         | engine activity + Listen-vs-Gold agreement (G3b proxy)               |
| `npm run eval:fidelity`                       | G4: critical-literal preservation; **fails the build on violations** |
| `npm run eval:tts:live`                       | G1: real provider latency (requires credentials, refuses mock)       |
| `npm run test:provider:live`                  | opt-in live NaN wiring check (local only)                            |

## Phase 0 gates

Defined in [docs/phase-0.md](docs/phase-0.md) with explicit GO/NO-GO
criteria. Current state:

- **G4 Fidelity** — ✅ passing (0 violations / 0 silent losses on corpus;
  `evaluation/results/fidelity.json`).
- **G2 Extraction** — ✅ measured (native PDFs: ~100% content recall,
  headings recovered; tables/two-column are documented gaps —
  `evaluation/results/extraction.json`).
- **G3b proxy** — automatic agreement between Listen and Manual Gold on
  `nested-regulation-01`: **0.95** word-level Dice
  (`evaluation/results/spoken.json`); human A/B still pending.
- **G3a / G3b human** — ⏳ needs the listening protocol
  (`evaluation/results/g3*.example.csv`).
- **G1 TTS latency** — ⏳ open: no NaN credentials existed in this
  environment; adapter wiring is mock-tested only.

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
React, `idb`, `zod`) are permissively licensed; bundled model weights and
audio (when using a real provider) are governed by **their** terms, not this
license, and are never redistributed here.
