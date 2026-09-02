# ADR-002: NaN is validation infrastructure, not product infrastructure

- **Status:** accepted
- **Date:** 2026-09-01

## Context

Phase 0 needs real TTS audio (Kokoro-class quality) to judge the hypothesis,
but committing to a production speech stack is premature and licensing/capacity
questions are unresolved. NaN (OpenAI-compatible `/audio/speech` endpoint) can
serve as a stand-in during validation.

## Decision

Use NaN behind the `SpeechProvider` interface **explicitly labeled
DEVELOPMENT / VALIDATION INFRASTRUCTURE**:

- All calls flow through the server-side adapter (`nan-provider.ts`); the
  browser never sees credentials (enforced by env-only injection, startup
  validation, and tests that assert no key material in responses/logs).
- The domain depends only on `SpeechProvider`; NaN types never leak.
- Pacing/concurrency is configured from _provider-specific measured limits_
  (`SPEECH_REQUESTS_PER_MINUTE`), not generic assumptions, with default
  concurrency 1.
- Before any public beta: review provider ToS, model weight licensing (Kokoro),
  third-party serving rights, rate limits, and availability expectations. A
  personal/community key is not assumed to grant serving arbitrary users.
- Replacement path is documented (`docs/providers.md`): self-hosted Kokoro,
  other commercial or OpenAI-compatible providers, or local inference slot in
  as a new adapter.

## Consequences

- (+) Experiment proceeds now; production decision is deferred to evidence.
- (+) Lock-in is structurally prevented (interface + adapter + tests).
- (−) Live NaN behavior is untested in this environment (no credentials):
  wiring is mock-verified; G1 stays open until `eval:tts:live` runs for real.
- (−) There is an ongoing temptation to "just ship it" on NaN; the repo text
  (README footer, UI badge "validation infra", this ADR) keeps countering it.
