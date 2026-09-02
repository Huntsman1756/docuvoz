# Test corpus

Phase 0 needs difficult Spanish financial/regulatory PDFs. This directory
documents the corpus design and how to extend it. **It contains no copyrighted
documents.** The actual, legally-redistributable synthetic fixtures are
generated into `public/corpus/` (served to the browser and read by the
evaluators) via:

```bash
npm run fixtures
```

## Categories (from the specification)

| Category               | Covered by                                       | Notes                                                                                                                                   |
| ---------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `native-simple`        | `simple-01` (synthetic)                          | baseline sanity + e2e                                                                                                                   |
| `nested-regulation`    | `nested-regulation-01` (synthetic)               | articles, apartados, párrafos, letras, annexes, obligations/exceptions, dates, %, EUR, T+2, BOE citation. Has a Manual Gold file (G3a). |
| `financial`            | `financial-report-01` (synthetic)                | ISIN/LEI, basis points, EUR millions, ranges, acronyms.                                                                                 |
| `extraction-artifacts` | `extraction-artifacts-01` (synthetic)            | repeated chrome, stray whitespace, hyphenated line breaks.                                                                              |
| `two-column`           | not yet generated                                | known hard case; see "adding fixtures".                                                                                                 |
| `tables`               | partial (table-cell blocks in nested-regulation) | browser extractor does **not** detect tables — measured as a G2 gap.                                                                    |
| `footnotes`            | partial (footnote blocks)                        | needs a real multi-footnote page.                                                                                                       |
| `scanned`              | none                                             | needs OCR; out of browser-path scope.                                                                                                   |
| `mixed-layout`         | none                                             | future.                                                                                                                                 |

Every fixture's _purpose_ is recorded in `public/corpus/manifest.json`
(`description` field) and regenerated deterministically, so the manifest and
files never drift.

## What each fixture provides

- **PDF** (`public/corpus/pdfs/<id>.pdf`) — fed to the browser extractor.
- **Reference export** (`public/corpus/reference/<id>.json`) — a
  Docling-shaped `StructuredDocument` acting as the G2 upper-bound baseline.
- **Manual Gold** (`public/corpus/gold/<id>.json`, optional) — human-authored
  spoken text for the G3a/G3b experiments.

## Adding fixtures

### Synthetic (committed, safe)

1. Add an entry to `scripts/fixtures-def.mjs` (blocks + chrome + optional gold).
2. `npm run fixtures` regenerates PDFs, reference JSON, gold and the manifest.
3. Add at least one golden test and one fidelity case if you introduce a new
   normalization pattern.

Keep synthetic text _fictitious_: it may imitate the style of BOE/CNMV/
Banco de España/EUR-Lex documents but must not reproduce real provisions.

### Real-world documents (NOT committed)

For genuine regulatory PDFs you hold legally:

1. Do **not** commit them (Spanish BOE texts are subject to reuse conditions;
   CNMV/Banco de España/EUR-Lex material has its own terms). This repo must
   stay clean for public redistribution.
2. Place them under a local, git-ignored directory, e.g.
   `evaluation/corpus/local/` (create it; it is ignored below).
3. Record metadata only, in `evaluation/corpus/local/manifest.local.json`:

   ```json
   {
     "entries": [
       {
         "id": "real-boe-circular-xxxx",
         "acquiredFrom": "https://www.boe.es/eli/es/cir/2024/…  (document the URL)",
         "title": "…",
         "sha256": "<hash of the exact bytes you used>",
         "redistribution": "not-redistributed",
         "notes": "why this fixture exists (e.g. 'two-column annex with footnotes')"
       }
     ]
   }
   ```

4. Reference the document in the UI by loading it via the drop-zone (the app
   parses locally and never uploads it). To benchmark real Docling against it,
   see below.

## Benchmarking real Docling (optional, external)

The in-repo "reference" is synthetic (so it can ship). To measure G2 against a
**real** desktop parser on a document you hold legally:

```bash
pip install docling
docling path/to/your/document.pdf --to json   # produces a DoclingDocument JSON
```

Then adapt Docling's JSON into `StructuredDocument` in a small throwaway script
under `evaluation/corpus/local/` and compare it with the browser export using
the same diff logic in `evaluation/scripts/run-extraction-eval.ts`. Results are
local (the documents are not redistributable); record aggregate numbers and
hashes in your PR, never the source PDFs. This is the honest way to close the
"synthetic reference" caveat noted in `docs/phase-0.md`.

## Ignored local artifacts

```gitignore
# add to .gitignore if you create these
evaluation/corpus/local/
```
