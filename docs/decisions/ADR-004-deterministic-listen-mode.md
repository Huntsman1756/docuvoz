# ADR-004: Deterministic Listen mode (rules engine, no LLM)

- **Status:** accepted
- **Date:** 2026-09-01

## Context

The tempting shortcut for "make documents nicer to hear" is LLM rewriting.
For financial/regulatory Spanish text that is disqualifying: meaning lives in
exact quantities, deadlines, negations and qualifications ("deberá" vs
"podrá", "no deberá", "salvo que"), and an LLM can silently alter any of them.
The hypothesis under test is specifically about a **deterministic spoken
representation**.

## Decision

Listen mode is a pure, versioned rules pipeline with no LLM, no network and no
hidden state:

1. **Narrow rule families** (`src/domain/spoken/rules/<family>.ts`), each a
   small module with unit tests — explicitly _not_ one giant regex file.
2. **Ordered, composable pipeline** (specific rules consume spans before the
   generic number rule verbalizes what remains).
3. **Fidelity gate** (`fidelity.ts`): every segment is validated against the
   critical-token inventory; failure ⇒ fall back to literal text, flagged in
   stats and UI. Unsafe output is never returned silently.
4. **Golden tests are the contract**: expected spoken text is human-written;
   regeneration scripts exist but a human must review changes.
5. **Engine version in cache keys**: rule changes cannot reuse obsolete audio.
6. Manual Gold (human-authored) is kept as an experimental _upper bound_ only,
   never reachable by the engine; LLM "Adapted" mode, if ever built, is a
   separate opt-in mode that may never mix into Listen.

## Consequences

- (+) Fully testable offline; CI never depends on a model provider.
- (+) "Preserved" is machine-provable per segment; behavior is reproducible.
- (−) Ceiling: the engine only captures part of what a skilled human could do
  (that gap is exactly what G3b measures).
- (−) Rule maintenance is real work; conservative fall-back behavior keeps it
  safe but can leave ugly literal text in audio (surfaced via fallback stats).
