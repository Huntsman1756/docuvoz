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

| Gate          | Command                   | Network? | Depends on provider? |
| ------------- | ------------------------- | -------- | -------------------- |
| G2 extraction | `npm run eval:extraction` | no       | no                   |
| — spoken      | `npm run eval:spoken`     | no       | no                   |
| G4 fidelity   | `npm run eval:fidelity`   | no       | no                   |
| G1 TTS        | `npm run eval:tts:live`   | **yes**  | **yes** (NaN)        |

The first three run in CI-able, offline conditions over the synthetic corpus.
`eval:tts:live` refuses to run unless `RUN_LIVE_PROVIDER=1` and
`SPEECH_PROVIDER=nan` with real credentials, because mock latency is not a
measurement (see `docs/providers.md`).

`npm run eval:fidelity` exits non-zero if any critical literal is lost,
invented, or muted with meaning — an unsafe transformation **blocks
progression** (gate G4).

## Human gates (recorded as CSV, not faked by a script)

These require ears. They cannot be reduced to a green checkmark, so the
harness only provides the automatic proxy (G3b gold agreement) and templates:

- `results/g3a.example.csv` — Manual Gold vs Literal (product hypothesis).
  If Manual Gold is **not** clearly better, the project should stop.
- `results/g3b.example.csv` — Listen vs Manual Gold (automation viability).

Copy the `.example.csv` to the non-example name, fill it in, and commit real
observations with the `fixture`, `evaluator`, and `notes` columns. Do not
invent numbers: an empty honest file beats a full dishonest one.

## Honesty rules for this directory

1. Regenerate results with the scripts before citing them; do not hand-edit
   generated JSON.
2. `results/*.json` are git-tracked so the shipped numbers are auditable.
3. Never present G4 (literal preservation) as evidence of semantic
   faithfulness — they are different properties (see ADR-005).
4. The reference corpus is synthetic; results overstate confidence on real
   messy PDFs. Say so whenever the numbers are quoted.
