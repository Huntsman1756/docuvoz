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
   Regenerates audio deterministically from a recorded seed. **Pre-registered
   scope decision (2026-09-02):** the shipped 5 dense segments (≈2–3 min)
   are the accepted first G3a signal; do NOT extend gold to 8–12 min before
   seeing round-1 results. The prepare script's sub-8-minute warning is known
   and expected. Expansion is only considered if round 1 is strongly positive
   and a round-2 confirmation is designed in advance.
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

**Neutral instruction given to evaluators (verbatim, nothing more):**

> Vas a escuchar dos versiones del mismo fragmento. Evalúa cuál funciona
> mejor para entender el contenido mientras lo escuchas.

No mention of "improved", "optimized", "AI", which condition is the
engine's, the project, or what is being demonstrated.

## Pre-registered decision criteria (fixed 2026-09-02, before any session)

Exploratory test with 2–4 listeners — no inferential statistics, no
p-values. The thresholds below are a predeclared **product bar**, not
significance. With 4 listeners × 5 pairs (20 comparisons):

```text
GATE: G3A_PRODUCT_HYPOTHESIS

PASS  (all of):
- Manual Gold preferred in ≥70% of pairwise comparisons (≥14/20; scaled
  proportionally for fewer listeners)
- comprehension not worse than Literal (objective questions + ratings)
- listening ease (followability) improves consistently
- fatigue does not materially worsen (reversed scale)
- confidence does not materially worsen
- improvement appears across multiple pairs, not one exceptional sample

FAIL  (any of):
- preference ≈50/50 or favors Literal
- comprehension degrades
- perceived improvement is negligible
- benefit comes from only one pair

INCONCLUSIVE:
- listeners strongly disagree (see per-listener pattern below)
- subjective ratings improve but comprehension worsens
- sample reveals an experimental-design problem
```

Per-listener patterns are reported, not just aggregates: `5/5, 5/5, 4/5,
0/5` is a disagreement finding, not a 14/20 pass. Dimensions analyzed
separately: PREFERENCE / COMPREHENSION / EASE / FATIGUE / CONFIDENCE; the
decisive pair is **comprehension + preference** — prettier audio with worse
comprehension kills the thesis.

If the initial signal is weak or negative, report it honestly and recommend
STOP; do not expand the experiment to fish for a positive result.

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

## Pre-exposure amendment — 2026-09-02

This amendment was made after stimulus generation QC and before any listener
was exposed to the experiment. No Literal or Manual Gold text, randomization,
side assignment, questions, scoring criteria, or generated audio was changed
as a result of this amendment.

### Total stimulus duration

The previously stated target of 90–120 seconds per condition was an engineering
planning target, not a product-hypothesis threshold.

The generated fixed stimulus set contains:

- Literal total duration: 81.3 s
- Manual Gold total duration: 88.7 s
- 8 paired comparisons

For G3a, a total duration of 80–120 seconds per condition is accepted.

The lower bound was amended because the existing 8-pair corpus provides the
intended diversity of regulatory constructions, and adding material solely to
cross an arbitrary duration threshold would change the experiment without
adding a new hypothesis-relevant construct.

### Pair duration balance

The previous absolute requirement of <= 2.0 seconds difference per pair is
withdrawn as a hard acceptance criterion.

Manual Gold deliberately verbalizes written forms such as dates, percentages,
legal references, abbreviations, and units. These transformations can
legitimately increase utterance duration, especially for longer source
segments. Absolute duration difference therefore does not scale appropriately
with clip length.

Pair duration is retained as a reported QC metric.

No silence padding, playback-speed manipulation, text deletion, text addition,
or other duration compensation is permitted.

The generated stimulus set has:

- maximum observed pair duration ratio: 1.32
- largest absolute difference: 2.3 s
- affected longest pair: 18.8 s Literal vs 21.2 s Manual Gold

These differences are accepted as properties of the fixed spoken
representations, not corrected post hoc.

### Experimental freeze

After this amendment is committed together with the exact WAV stimuli,
manifest hashes, response sheet, questions, and protocol:

- the 8 source pairs are frozen;
- Literal text is frozen;
- Manual Gold text is frozen;
- WAV stimuli are frozen;
- randomization and side assignment are frozen;
- questions and scoring are frozen;
- G3a decision thresholds remain unchanged.

No further stimulus changes are permitted in response to listener outcomes.
