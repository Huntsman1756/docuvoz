# Evaluation

Reproducible, machine-readable answers to the Phase 0 questions. Read
[docs/phase-0.md](../docs/phase-0.md) for what each gate means and how it is
judged, and [docs/evaluation.md](../docs/evaluation.md) for the metric
catalogue.

## Layout

```text
evaluation/
  README.md              (this file)
  corpus/                acquisition + category documentation (no copyrighted PDFs)
  scripts/               run-*.ts evaluators (tsx)
  results/               generated outputs + human-gate templates
```

## Running

| What                                     | Command                   | Network? | Depends on provider? |
| ---------------------------------------- | ------------------------- | -------- | -------------------- |
| extraction smoke (synthetic, not G2)     | `npm run eval:extraction` | no       | no                   |
| spoken engine + regression metric        | `npm run eval:spoken`     | no       | no                   |
| G4a fidelity                             | `npm run eval:fidelity`   | no       | no                   |
| G1 live TTS measurement                  | `npm run eval:tts:live`   | **yes**  | **yes** (NaN)        |
| G1 harness wiring smoke (never evidence) | `npm run eval:tts:wiring` | no       | mock                 |

The first three run in CI-able, offline conditions over the synthetic corpus.
`eval:tts:live` refuses to run unless `RUN_LIVE_PROVIDER=1` and
`SPEECH_PROVIDER=nan` with real credentials, because mock latency is not a
measurement (see `docs/providers.md`); wiring-smoke output goes to a separate,
clearly-named file so it can never be mistaken for G1 evidence.

`npm run eval:fidelity` exits non-zero if any critical literal is lost,
invented, or muted with meaning — an unsafe transformation **blocks
progression** (gate G4a).

## Human gates (recorded as CSV/JSONL, not faked by a script)

These require ears. They cannot be reduced to a green checkmark, so the
harness only provides prepared instruments and templates:

- `experiments/g3a/` — **G3a blind listening experiment** (product
  hypothesis): paired Literal vs Manual Gold clips with randomized blinded
  labels, subjective ratings and objective comprehension questions. Build it
  with `npm run g3a:prepare -- --dry-run` (offline plan) or with real
  credentials for audio. If Manual Gold is **not** clearly better, the
  project stops.
- **G3b human** — three-condition capture-ratio protocol (Literal / Gold /
  Listen), see `docs/phase-0.md`. The Dice agreement in
  `results/spoken.json` is an engineering regression metric, not a
  participant in this decision.
- `experiments/g4b/` — **G4b semantic fidelity**: deterministic
  source→spoken review packet (`npm run g4b:packet`) annotated by hand.
  No LLM judge is introduced or needed.
- `results/g3a.example.csv` / `g3b.example.csv` — legacy simple templates,
  superseded by `experiments/g3a/answer-sheet.csv` for G3a.

Copy templates, fill them in, and commit real observations. Do not invent
numbers: an empty honest file beats a full dishonest one.

## Honesty rules for this directory

1. Regenerate results with the scripts before citing them; do not hand-edit
   generated JSON.
2. `results/*.json` are git-tracked so the shipped numbers are auditable.
3. Never present G4a (literal preservation) as evidence of semantic
   faithfulness — that is G4b's job (see ADR-005).
4. The reference corpus is synthetic; extraction results are a smoke test of
   the browser pipeline, never "G2 PASS". Word recall can hide wrong reading
   order on real messy PDFs.
5. Word-level gold agreement is a regression alarm for engineers: it cannot
   hear, and it penalizes orally-correct surface changes by design.
6. Infrastructure completion (`PHASE_0_INFRASTRUCTURE = PASS`) is not
   validation of anything. The product decision remains
   `PRODUCT_GO_NO_GO = NOT_DECIDED` until G1, G2-real, G3a, G3b-human and
   G4b have real evidence.
