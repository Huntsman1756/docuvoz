# G3a — Blind listening experiment: Literal vs Manual Gold

**Gate:** `G3A_PRODUCT_HYPOTHESIS`. This experiment decides whether the
product hypothesis ("an optimized spoken representation makes difficult
documents meaningfully easier to listen to") has any headroom at all. If
Manual Gold is **not** clearly better than Literal, the project stops —
regardless of how green the test suite is.

**What may never happen:** filling `answer-sheet.csv`/`questions.csv` by
guessing, running it with mock tones, or letting any script write these
files' answer columns. `G3A` becomes PASS only when a human evaluator's real
session data is committed here.

## Prerequisites

1. Real TTS credentials (see `docs/providers.md`). Set `NAN_TTS_FORMAT=wav`
   so clip durations are measurable for the balance check.
2. `RUN_LIVE_PROVIDER=1 SPEECH_PROVIDER=nan npm run g3a:prepare`
   Regenerates audio deterministically from a recorded seed. Target is
   ≈8–12 minutes per condition; the shipped gold covers 5 dense segments
   (≈2–3 min). **Extend `public/corpus/.../gold` by hand** (human-authored,
   meaning-preserving) until the prepare script reports a compliant duration
   — the script prints a warning below 8 minutes.
3. Offline structure review is always available:
   `npm run g3a:prepare -- --dry-run` (no audio, no quota).

## Materials given to the evaluator

- `answer-sheet.csv` — one blinded row per pair, columns for per-clip
  ratings and preference.
- `questions.csv` — objective comprehension items.
- `audio/*.wav` — clips named only by opaque ids (`g3a-xxxxxxxx`).

**Never give the evaluator:** `manifest.json`, `private/key.json`, or the
gold file. Blinding is operational: the sheet is ordered by
`presentation_order`, sides are randomized per pair by a seeded PRNG
(recorded in `manifest.json` and the session notes).

## Procedure

For each row in `presentation_order`:

1. Play the left clip fully, then the right clip fully (same content, two
   renderings; the evaluator does not know which is which).
2. Rate each clip 1–5:
   - comprehension — how easy it was to understand while hearing
   - followability — could you track structure (articles, letters, numbers)?
   - fatigue — 1 = least fatiguing, 5 = most (higher is worse)
   - confidence — how sure are you that you understood it correctly?
3. Record `preference`: `left`, `right`, or `none`.
4. One-line notes if anything stood out (cutoffs, confusion, naturalness).

After **all** pairs, without replaying: answer `questions.csv` from memory
(deadline, exception, article referenced, obligation vs permission,
amount). Then the key is revealed and correctness is scored — this measures
_actual comprehension_, so results cannot ride on "this voice sounds nicer".

## Analysis (after the key is revealed)

- Per condition (literal/gold): mean comprehension, followability,
  confidence; mean reversed fatigue; preference win count; question
  correctness count.
- Fatigue must be compared reversed (gold should _reduce_ fatigue).
- **Decision rule:** Gold is "clearly better" if it wins a strong majority
  of preferences, shows a visible rating improvement on ≥3 of the 4
  dimensions, and question correctness does not regress. With one or two
  evaluators this is a documented qualitative judgment — write the judgment
  and the evidence lines into the session notes; do not invent statistics
  the sample cannot support.

## If G3a passes → G3b (automation viability)

Rerun the same protocol with three conditions per block
(Literal / Manual Gold / Listen-v0, all blinded), and compute

```text
capture ratio = (Listen − Literal) / (Gold − Literal)
```

on the comprehension ratings. Example: Literal 62, Gold 82, Listen 76 ⇒
capture 0.70. Gold +20 with Listen +2 proves the thesis but **not** the
automation — report it as such. The word-level Dice number
(`results/spoken.json`) is an engineering regression alarm and plays no part
in this decision.
