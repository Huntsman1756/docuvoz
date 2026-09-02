# G4b — Semantic fidelity (human review)

**Gate:** `G4B_SEMANTIC_FIDELITY`. G4a proves literals survive mechanically.
G4b answers the question no mechanical check can: _is each transformation
the correct thing to say?_ A deterministic, conservative engine makes this
exhaustively reviewable by a human — that is precisely why **no LLM judge
exists in this repository** and none should be proposed.

## Procedure

1. Regenerate the packet (before review, never during):
   `npm run g4b:packet` → `review-packet.csv`.
2. For each row, read the `source_text` and `spoken_text` **aloud** in
   Spanish. The spoken column must preserve modality (must/may/must not),
   conditions, exceptions, scopes, references and structure — not just
   characters.
3. Mark `verdict_y_n` (Y = says the right thing) and add a `note` for any
   hesitation. Hesitation is a finding, not noise.
4. Pay special attention to rows whose `source_text` contains sensitive
   constructions — obligations/negations/exceptions/conditions/deadlines
   (`deberá`, `no deberá`, `salvo que`, `siempre que`, `a más tardar`,
   `quedarán exentas`). The engine must never alter their modality; if a
   neighbouring transformation makes a sentence _sound_ like it did, that
   is a G4b finding even though G4a stayed green.
5. If the packet shows few or no rows for a construction class that exists
   in real regulation, the packet itself is a coverage gap — add a golden
   fixture for it (this is how sensitive-construction coverage grows; no
   LLM judge is ever introduced as a shortcut).

## Verdict rule

- `G4B_SEMANTIC_FIDELITY = PASS` **only** when 100% of rows carry a human
  `Y` and the filled CSV is committed here.
- Any `N` → file it as a rule defect; a fix requires a
  `SPOKEN_ENGINE_VERSION` bump (cache invalidation) and a fresh review of
  at least all rows in the affected class.
- Coverage claim must be honest about construction classes: passing on the
  synthetic corpus does not cover constructions that exist in real
  regulation but not in the packet — growing the packet alongside the
  corpus is part of the review.

## What this is not

- Not a listening-quality experiment (that is G3a/G3b — ears, not eyes).
- Not literal preservation (that is G4a, machine-checked).
