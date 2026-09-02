# Speech providers

## The contract

Everything the domain knows about synthesis is in
`src/domain/speech/types.ts`:

```ts
interface SpeechProvider {
  readonly name: string;
  synthesize(request: SpeechRequest): Promise<SpeechResult>;
}
```

The domain and the API layer depend only on this interface. Provider-specific
types never leak outward. The pipeline:

```text
/api/speech route ─► PacedProvider ─► concrete provider (mock | nan | future)
```

`PacedProvider` (`src/adapters/speech-providers/pacing.ts`) owns cross-cutting
reliability so concrete providers stay small:

- global concurrency cap (default **1** — do not parallelize just because you
  can);
- minimum inter-request interval derived from `SPEECH_REQUESTS_PER_MINUTE`
  (token-bucket style pacing modeling provider-specific limits);
- bounded retries with exponential backoff + jitter for retryable errors;
- cancellation pass-through via `AbortSignal`.

## Built-in providers

### `mock` (default)

Deterministic tiny WAV whose length is derived from the text hash. No network.
Used by all tests, CI, and local development without credentials. It exercises
the full stack (queue, cache, metrics) but says nothing about real latency —
gates requiring real measurements must not use it.

### `nan` — DEVELOPMENT / VALIDATION INFRASTRUCTURE

> **NaN is validation infrastructure, not product infrastructure.**

`src/adapters/speech-providers/nan-provider.ts` speaks the OpenAI-compatible
`POST {base}/audio/speech` protocol (`model`, `input`, `voice`, `speed`,
`response_format`) with a bearer key from the server environment. It is used
in Phase 0 to answer: _does Kokoro-via-NaN audio quality and latency support
the experiment?_

**Before any use beyond personal validation, review:**

- the provider's **licensing and terms of service** for the model weights in
  use (Kokoro's own license) and for API usage;
- **third-party serving rights**: a personal/community key may not legally or
  operationally serve arbitrary third-party users;
- **provider-specific rate and concurrency limits** (Kokoro plan limits are
  _not_ generic API limits) — configure `SPEECH_REQUESTS_PER_MINUTE` and
  `SPEECH_MAX_CONCURRENCY` from _measured_ reality, not guesses;
- **availability expectations**: no SLA is implied; failures must remain
  visible (stable error codes) and never silently degrade into mock audio.

**Not yet done in this environment:** the NaN adapter is covered by unit
tests with mocked fetch (request shape, 429/5xx mapping, no credential leaks)
and an **opt-in live test** (`npm run test:provider:live` with
`RUN_LIVE_PROVIDER=1`, `SPEECH_PROVIDER=nan`, valid `NAN_BASE_URL` +
`NAN_API_KEY`). It has **not** been exercised against a live endpoint here
because no credentials exist in this environment. G1 (latency) therefore
remains open until run with real credentials via `npm run eval:tts:live`.

### Configuring NaN locally

```bash
# .env.local
SPEECH_PROVIDER=nan
NAN_BASE_URL=https://<endpoint>/v1
NAN_API_KEY=<your key>          # server-only; never exposed to the browser
NAN_TTS_MODEL=kokoro
NAN_TTS_VOICE=<a Spanish-capable voice you have validated>
NAN_TTS_FORMAT=mp3
SPEECH_REQUESTS_PER_MINUTE=<measured plan limit>
```

Keys never reach the browser: only `/api/health` exposes non-secret defaults
(provider name, model, voice) so the client can compute identical cache keys.

## Adding a provider (e.g. self-hosted Kokoro)

1. Create `src/adapters/speech-providers/<name>-provider.ts` implementing
   `SpeechProvider`. Throw `SpeechError` with the right
   `code`/`retryable`/`status` so pacing and API mapping keep working.
2. Register it in `createProvider()` (`src/server/config.ts`) and extend the
   `SPEECH_PROVIDER` enum + env schema (fail-fast validation).
3. Add unit tests with a stubbed transport (mirror `nan-provider.test.ts`).
4. Audio settings (model/voice/format/speed) flow into the cache key
   automatically via `/api/health` + `computeAudioCacheKey`; make sure your
   provider reports the same defaults.
5. Document its license/limits here. Do not combine permissive code with
   weights/assets whose redistribution terms are incompatible.

## What "Adapted" would not change

A future LLM "Adapted" mode is a _text_ pipeline concern; it reuses this same
speech provider layer unchanged. It must stay opt-in, disclose external
transmission, and never overwrite the source representation.
