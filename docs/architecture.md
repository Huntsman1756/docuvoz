# Architecture

AUIDIO NAN is a web-first **reading laboratory**, not a product. The pipeline
under test:

```text
PDF bytes
  ↓  (browser only — pdf.js)
StructuredDocument            src/domain/documents/types.ts
  ↓  (pure, deterministic)    adapters/document-parsers/build-document.ts
SpokenPlan (Literal | Listen | Manual Gold)
  ↓                            domain/spoken/pipeline.ts + rules/* + fidelity.ts
SpeechChunk[] (≈400 chars)     domain/spoken/speech-plan.ts
  ↓  (HTTP, one chunk per call)
/api/speech                    server/api/speech-handler.ts
  ↓
SpeechProvider (mock | nan)    domain/speech/types.ts (interface)
  ↓
audio bytes → IndexedDB / filesystem cache → <audio> playback + highlight
```

## Layers and boundaries

| Layer          | Location                          | May depend on             |
| -------------- | --------------------------------- | ------------------------- |
| Domain (pure)  | `src/domain/**`                   | nothing outside domain    |
| Adapters       | `src/adapters/**`                 | domain contracts          |
| Infrastructure | `src/infrastructure/**`           | domain contracts          |
| Server         | `src/server/**`, `src/app/api/**` | domain + adapters + infra |
| Client         | `src/components/**`, `src/lib/**` | domain types only         |

Rules enforced by construction (and by review):

1. **The domain never imports provider, parser or framework types.**
   `SpeechProvider` is a 2-member interface (`src/domain/speech/types.ts`);
   NaN-specifics live only in `src/adapters/speech-providers/nan-provider.ts`.
2. **The source document is never mutated.** `buildSpokenPlan` returns new
   segments carrying the original `sourceText` (regression-tested).
3. **All transformation risk flows through the fidelity gate.** A rejected
   transformation falls back to literal text for that segment and is visible
   in the UI and in `plan.stats` — never silent.
4. **Secrets are server-only.** The browser can never learn `NAN_API_KEY`;
   `/api/health` exposes non-secret runtime defaults so client and server can
   compute _identical_ cache keys.
5. **The client talks to one endpoint.** Everything else is local: parsing,
   normalization, chunking, highlighting, IndexedDB cache.

## Functional core / imperative shell

The core (rules, fidelity, chunking, pacing policy) is pure and testable
without network or DOM. The shells — Next.js route handlers, pdf.js loader,
`HTMLAudioElement`, IndexedDB, filesystem cache — are thin and injectable
(`fetchFn`, `sleep`, `random`, `fetchImpl` parameters) so behavior around
timing and failure can be tested deterministically.

## Audio cache coherence

Cache key = SHA-256 over `{text, provider, model, voice, speed, format,
SPOKEN_ENGINE_VERSION}` (`src/infrastructure/cache/cache-key.ts`, WebCrypto so
browser and Node produce the same digest). Changing any rule bumps the engine
version in `src/domain/spoken/version.ts`, which makes stale audio
unreachable without any explicit invalidation pass. Keys are content hashes,
so entries are immutable; the filesystem cache enforces a byte cap by
evicting oldest entries.

## Speech queue

`SpeechPlayer` (`src/lib/speech-player.ts`) implements
_current → playing, next → ready, next+1 → generating_ with bounded prefetch
(depth 2), deduplication (one in-flight promise per chunk), epoch-token
cancellation on seek/document switch, and metrics (request latency, queue
wait, underruns, cache outcomes). Concurrency is **not** increased to make
things faster: pacing is a server-side policy that mirrors the provider's
real limits (`SPEECH_REQUESTS_PER_MINUTE`).

## Where to look first

- Spoken rules: `src/domain/spoken/rules/` + `docs/spoken-representation.md`
- Fidelity: `src/domain/spoken/fidelity.ts` + `critical-tokens.ts`
- Provenance: `src/domain/provenance/provenance.ts` + `docs/document-model.md`
- Provider swap: `docs/providers.md`
- Experiments/gates: `docs/phase-0.md`, `evaluation/README.md`
