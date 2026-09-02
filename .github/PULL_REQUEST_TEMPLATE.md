## Summary

- What changed and why (link the issue if there is one).

## Type of change

- [ ] Normalization rule (Listen engine)
- [ ] Extraction / parser adapter
- [ ] Fidelity / provenance
- [ ] Provider / API / cache / player
- [ ] Evaluation harness or corpus
- [ ] Docs / repo infrastructure
- [ ] Refactor / chore

## Fidelity & determinism checklist

- [ ] `npm test` passes locally (offline, mock provider).
- [ ] Golden fixtures added/updated with **hand-reviewed** expected output.
- [ ] `SPOKEN_ENGINE_VERSION` bumped if the engine's observable output changed.
- [ ] `npm run eval:fidelity` exits 0 (no critical literal lost/invented/muted).
- [ ] No summarization/paraphrase/reordering was introduced into Listen.
- [ ] No provider type or credential touched the domain layer or the browser.

## Evidence

Paste the relevant numbers (before/after): `evaluation/results/*.json`
diffs, rule hit counts, or the source→spoken pair this PR enables.

## Known limitations introduced

Be explicit. Unstated limitations are worse than stated ones.
