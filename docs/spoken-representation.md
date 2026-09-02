# The spoken representation engine (Listen mode)

Versioned by `SPOKEN_ENGINE_VERSION` (`src/domain/spoken/version.ts`), which
is part of every audio cache key. Any rule change that alters observable
output requires a version bump.

## Contract

`buildSpokenPlan(doc, "listen")` (`src/domain/spoken/pipeline.ts`) is:

- **Deterministic** — same input + same engine version ⇒ same plan, always.
- **Non-mutating** — the source document is never modified; each segment
  keeps `sourceText` alongside the spoken `text`.
- **Conservative** — when in doubt, the original text is preserved.
- **Reversible-in-principle** — provenance + transformation records make it
  possible to reconstruct what happened to every segment.

Allowed transformations: verbalize numbers/percentages/dates/currency/legal
references/identifiers/settlement notation; expand safe abbreviations and
acronyms; mute repeated page chrome; insert prosodic pauses; normalize PDF
artifacts.

Forbidden: summarizing, paraphrasing, reinterpreting, reordering, removing
legal qualifications, altering dates/amounts/references/thresholds/
percentages/deadlines/conditions.

## Pipeline

```text
StructuredDocument.blocks
  → detectChromeBlocks (Listen only)     layout-noise.ts
  → per block: applyRules(LISTEN_RULES)  rules/index.ts (ordered chain)
  → heading prosody (append ",")
  → validateFidelity(source, spoken)     fidelity.ts
      PASS → transformed segment (with transformation records)
      FAIL → REJECT: fallback to literal text, flagged in stats + UI
```

## Rule families (`src/domain/spoken/rules/`)

Order matters: specific rules consume their spans **before** the generic
`numbers` rule verbalizes leftover digits.

| Rule id                              | Module              | Example                                                                              |
| ------------------------------------ | ------------------- | ------------------------------------------------------------------------------------ |
| `abbreviations`                      | abbreviations.ts    | `núm. 288` → `número 288`                                                            |
| `numero-sign`                        | abbreviations.ts    | `nº 3` → `número 3`                                                                  |
| `acronyms`                           | abbreviations.ts    | `BOE` → `B O E`; `(UE)` → `(U E)`                                                    |
| `provision-abbrev`                   | legal-references.ts | `D. A. 3.ª` → `disposición adicional 3.ª`                                            |
| `legal-references`                   | legal-references.ts | `art. 57.1.b)` → `artículo cincuenta y siete, apartado uno, letra be`                |
| `keyword-references`                 | legal-references.ts | `apartado b)` → `apartado be`; `sección (IV)` → `sección cuatro`                     |
| `roman-headings`                     | legal-references.ts | `Anexo II` → `Anexo dos`                                                             |
| `dates`, `dates-iso`, `dates-hyphen` | dates.ts            | `15/07/2024` → `15 de julio de 2024` (digits verbalized later)                       |
| `currencies`                         | money.ts            | `1.234,56 €` → `mil doscientos treinta y cuatro euros con cincuenta y seis céntimos` |
| `percentages`                        | money.ts            | `8,5 %` → `ocho coma cinco por ciento`                                               |
| `basis-points`                       | money.ts            | `25 pb` → `veinticinco puntos básicos`                                               |
| `settlement`                         | settlement.ts       | `T+2` → `T más dos`                                                                  |
| `ordinals`                           | numbers.ts          | `1.º` → `primero`; `3ª` → `tercera`                                                  |
| `time`                               | numbers.ts          | `14:00` → `14 horas`                                                                 |
| `slash-citations`                    | numbers.ts          | `Ley 47/2003` → `Ley 47, 2003` (pause; verbalized later)                             |
| `ranges`                             | numbers.ts          | `10–15` → `10 a 15` (hyphen date fragments excluded)                                 |
| `isin`, `lei`                        | identifiers.ts      | only with explicit context keyword; spelled with Spanish letter names                |
| `numbers`                            | numbers.ts          | fallback cardinal/decimal verbalization (Spanish conventions)                        |

Number verbalization lives in `src/domain/spoken/es-number.ts` (0 to
999 billones; `mil`, `un millón de euros`, `quinientos y uno`, combined
`veintidós`, decimals as `coma` + digits, trailing zeros preserved). Anything
ambiguous (`12.34`) or out of range returns `null` → text preserved.

## Fidelity safeguards (`fidelity.ts` + `critical-tokens.ts`)

Critical literals detected in the **source**: numeric literals, ordinals,
ISIN/LEI codes, and legal qualification phrases —

`deberá, podrá, no deberá, no podrá, salvo que, excepto, sin perjuicio de,
siempre que, antes de, después de, a más tardar, dentro de, queda prohibido,
no obstante, en ningún caso`

Validation is asymmetric on purpose:

- A token is **preserved** if it appears verbatim at a word boundary in the
  output, **or** a _value-preserving_ rule match consumed a span containing it
  (e.g. `1.234,56 €` → words).
- **Legal qualifications must always survive verbatim.** No rule may absorb
  them; their presence is non-negotiable.
- **Invention check:** numeric/identifier tokens that appear in the output but
  exist neither in the source nor in any rule replacement fail validation.

On failure the segment falls back to literal text (`fallbackApplied: true`,
`stats.rejected`), highlighted in the UI as _fidelity fallback_. A failed
validation never returns an unsafe transformed segment.

Machine verification proves TRACEABLE + PRESERVED. It does **not** prove
semantic faithfulness; that is the human gates (G3a/G3b).

## Testing strategy for rules

- Unit tests per rule (`tests/unit/rules.test.ts`).
- **Golden fixtures** (`tests/fixtures/golden/*.in.txt` + hand-written
  `.expected.txt`) over the full pipeline, asserting zero lost/invented
  critical tokens.
- Regeneration helper (`scripts/regenerate-golden.ts`) exists, but golden
  files are a human contract: never blindly accept engine output.
- Every bug discovered in the wild becomes a permanent golden/unit fixture.
