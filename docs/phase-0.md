# Phase 0 — objective, gates and status

Phase 0 is an **engineering laboratory** that decides whether the product
hypothesis is technically and experientially valid. It is _not_ a polished
consumer app. The repository must make each question below answerable by a
repeatable command or a scripted human protocol.

> **Vocabulary rule (binding):** _infrastructure_ status and _validation_
> status are never mixed. A gate is PASS only when its named evidence
> artifact exists and was actually produced. Green tests prove the laboratory
> works, not that the product hypothesis holds. Until every decision gate has
> real evidence, the project's overall state is `PRODUCT_GO_NO_GO = NOT_DECIDED`
> and must be quoted as such.

## Canonical gate state

Updated whenever evidence changes. Last measured: 2026-09-02.

```text
PHASE_0_INFRASTRUCTURE        = PASS   (builds, tests, gates runnable offline)
G1_TTS_LIVE                   = PASS   (NaN live run; scope-limited — see below)
G2_EXTRACTION_REAL            = OPEN   (only synthetic smoke evidence so far)
G3A_PRODUCT_HYPOTHESIS        = OPEN   (blind listening protocol prepared, not run)
G3B_AUTOMATION_PROXY          = PASS   (engineering regression metric ONLY — see below)
G3B_HUMAN                     = OPEN   (requires G3A + A/B/C listening protocol)
G4A_CRITICAL_LITERAL_PRESERV. = PASS   (machine-verified on corpus: 0 violations)
G4B_SEMANTIC_FIDELITY         = OPEN   (human review packet prepared, not reviewed)
PRODUCT_GO_NO_GO              = NOT_DECIDED
```

What each PASS is allowed to mean, and nothing more:

- `PHASE_0_INFRASTRUCTURE = PASS` — the experiment can be run. Says nothing
  about outcomes.
- `G3B_AUTOMATION_PROXY = PASS` — the deterministic engine reproduces the
  gold surface of the corpus at 0.95 **word-level Dice**. This is a
  _regression/coverage metric for engineers_: lexical similarity deliberately
  penalizes orally-correct surface changes and cannot hear anything. It is
  **not** evidence about listening experience and must never be cited as
  "the engine captures 95% of the benefit".
- `G1_TTS_LIVE = PASS` — measured 2026-09-02 against NaN cloud (kokoro,
  `ef_dora`, WAV, serial at the provider's published 15 rpm kokoro cap):
  12/12 real stratified chunks successful — TTFA p50/p95/max 0.93/1.63/1.63 s,
  wire latency p50/p95 1.01/1.77 s, RTF p50/p95 0.076/0.157, queue wait
  p50/p95 2.98/3.31 s (deliberate pacing, not provider slowness), 0 retries,
  0 provider errors, 0 HTTP 429/5xx — plus a sustained burn of 30 requests
  over 120 s with zero 429s. Evidence: `evaluation/results/tts.json`.
  Establishes only that the transport is suitable for Phase 0 interactive TTS
  validation. Does **not** establish production SLA, multi-user capacity,
  third-party serving rights, production suitability of NaN, or behavior
  above 15 rpm.
- `G4A = PASS` — critical literals (numbers, dates, amounts, identifiers,
  legal qualifications) provably survive Listen transformations on the
  evaluated corpus. This is literal preservation only. Semantic faithfulness
  is `G4B`, judged by humans on a review packet — for a deterministic,
  conservative engine this is tractable without any LLM judge.

What remains OPEN and why no technical green checkmark can close it:

- `G2_EXTRACTION_REAL` — the synthetic corpus measures the _browser pipeline
  loss_, not performance on real regulatory PDFs. Synthetic numbers
  (`tables 0/2`, `footnote 0/1`, ~100% recall) are a smoke test: word recall
  can hide the failure that matters — content present in semantically wrong
  order (e.g. two-column interleaving).
- `G3A` / `G3B_HUMAN` — require ears. No script may mark them.

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

Each gate has a named evidence artifact. Statuses live in the canonical table
at the top of this file — do not restate a status elsewhere without updating
that table.

### G1 — TTS live (sub-parts)

_Questions:_ `G1_PROVIDER_CONNECTIVITY` — does the real provider respond
through our adapter? `G1_PROVIDER_LATENCY` — are TTFA and request latency
acceptable for interactive web validation? `G1_PROVIDER_RATE_BEHAVIOR` — does
our configured pacing keep provider errors (429) at zero during a sustained
representative run?

_Evidence:_ `npm run eval:tts:live` → `evaluation/results/tts.json` across a
representative sample (~25 real Listen chunks): TTFA, wire latency, retries,
provider queue wait, audio duration, RTF, bytes, statuses, 429 count. A
sustained `--burn` mode measures 429 behavior at the configured plan limit.
The mock provider may exercise wiring only
(`npm run eval:tts:wiring` → `tts.wiring-smoke.json`); its numbers are
excluded from any G1 sub-status.

_Status:_ OPEN — no credentials exist in the current environment.

### G2 — Extraction (real documents)

_Question:_ does browser/local extraction preserve enough structure vs a real
reference parser on real regulatory PDFs?

_Evidence (open):_ five genuinely unpleasant legally-held documents (1
normal, 1 tables, 1 footnotes, 1 two-column/complex, 1 long/annexes) run
through browser extraction, real Docling, and human judgment. Docling is a
strong baseline, not an oracle.

_Synthetic smoke (done, not a gate):_ `npm run eval:extraction` measures the
browser pipeline against idealized synthetic references. Current numbers:
~100% content recall, headings recovered, reading order ok — **and**
`tables 0/2`, `footnote 0/1`. High word recall can mask the failure that
matters (all words present, semantically wrong order in two-column layouts),
so these results never close G2.

### G3a — Product hypothesis (blind human experiment)

_Question:_ is a manually optimized spoken version clearly better to listen
to than Literal, for equivalent content?

_Protocol:_ `evaluation/experiments/g3a/PROTOCOL.md`. Paired Literal/Gold
clips from `nested-regulation-01`, randomized blinded labels, subjective
ratings (comprehension, followability, fatigue, confidence, preference) plus
**objective comprehension questions** (deadline? exception? article
referenced? obligation or permission?) so results cannot rest on voice
preference. Target ≈8–12 minutes per condition; the shipped gold covers 5
dense segments — extend the gold by hand to widen coverage.

_Decision rule:_ if Manual Gold is **not** clearly better → **STOP**. Do not
continue building a complex product. 122 green tests do not vote here.

### G3b — Automation viability (human experiment + engineering metric)

_Question:_ does deterministic Listen retain a meaningful portion of Manual
Gold's benefit **as experienced by a listener**?

_Primary evidence (open):_ three-condition listening protocol
(Literal / Manual Gold / Listen) yielding the capture ratio:

```text
capture = (Listen − Literal) / (Gold − Literal)     e.g. (76−62)/(82−62) = 0.70
```

If Gold gains +20 and Listen gains +2, the thesis is proven but the
automation is not.

_Secondary (engineering regression only):_ `npm run eval:spoken` word-level
Dice vs gold (`spoken.json → goldAgreement`). Useful to catch rule
regressions; **not** an experience proxy — surface differences it penalizes
can be orally correct.

### G4a — Critical literal preservation (machine)

_Question:_ does any transformation silently lose or invent a critical
literal (number, date, amount, identifier, legal qualification)?

_Evidence:_ `npm run eval:fidelity` → `evaluation/results/fidelity.json`.
Independent recomputation from persisted provenance. **Any violation blocks
progression** (the script exits non-zero).

_Status:_ PASS on the corpus (0 violations, 0 fallbacks). Scope: literal
preservation only.

### G4b — Semantic fidelity (human, no LLM judge needed)

_Question:_ is each Listen transformation the correct thing to _say_ — e.g.
does "art. 57.1.b)" read as its structure means, do conditionals still
conditionalize?

_Evidence:_ `npm run g4b:packet` → `evaluation/experiments/g4b/`
source→spoken review packet over golden fixtures + corpus, annotated by hand
per construction class. Because Listen is deterministic and conservative,
exhaustive human review of a modest packet is honest and tractable; no
probabilistic judge is introduced.

## Interpretation limits (read before trusting a green gate)

- **TRACEABLE ≠ PRESERVED ≠ SEMANTICALLY FAITHFUL.** G4a proves _preserved_
  (literals survive); G4b is the human check that they are _said right_.
  G3a/G3b humans speak to _faithful listening_. No automated number in this
  repo claims either.
- The word-level Dice agreement in `spoken.json` is a rule-regression alarm.
  It can go down while listening quality goes up (good oral transformations
  change surface text on purpose). Never quote it as a percentage of the
  human benefit captured.
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
