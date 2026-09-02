# Privacy architecture

This document describes exactly what data leaves the browser, per mode. No
marketing claims: if it is not implemented, it is not promised.

## Default data flow (all modes)

```text
PDF ──► browser (pdf.js extraction)          bytes never leave the browser
     └─► spoken text (rules engine, local)
          └─► chunk text ──► POST /api/speech (same origin)
                               └─► provider API  (only when SPEECH_PROVIDER=nan)
          ◄── audio bytes ◄──┘
```

| Data                                  | Where it goes                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Original PDF bytes                    | **never leave the browser** in any mode (no uploads exist).                                         |
| Extracted full text                   | stays in browser memory/plan; not sent anywhere.                                                    |
| Spoken chunk text (≈400 chars)        | sent to **your own** `/api/speech` server.                                                          |
| Spoken chunk text                     | sent onward to the provider **only** when `SPEECH_PROVIDER=nan`.                                    |
| With `SPEECH_PROVIDER=mock` (default) | no provider call, no external network.                                                              |
| Document hash (SHA-256)               | computed locally; used as a document identifier and in logs fingerprints; not sent to the provider. |

## Server-side handling

- `/api/speech` validates with zod, caps text length and body size, and rate
  limits per client (in-memory).
- Audio responses are cached on the server filesystem under
  `SPEECH_CACHE_DIR` (`.cache/audio`), keyed by content hash. Anyone who can
  reproduce the exact chunk text + settings can read that entry from the cache
  directory, so **treat the cache directory as sensitive**.
- Logs are structured JSON. Document content is logged only as
  `length:sha256-12-hex` fingerprints. There is a test asserting raw content
  never reaches logs on success or failure.
- No analytics, no telemetry, no third-party scripts in the app.

## Client-side storage

- **IndexedDB** (`auidionan-audio`) stores synthesized audio blobs under the
  same content-hash key, for up to 30 days (best-effort pruning). This is
  local to the user's browser profile. Clearing site data removes it.
- No document text or PDFs are persisted client-side; the plan is rebuilt per
  session from the loaded document.

## Manual Gold / reference corpus files

Gold and reference JSON are static files served from the same origin and
contain only synthetic fixture content. Nothing user-specific is ever written
into them.

## Deferred (documented, not implemented)

- Adapted (LLM) mode: when it exists it must obtain explicit opt-in, disclose
  that content leaves to a model provider, and preserve original/spoken
  separation. It is out of Phase 0.
- Multi-user deployments require reworking rate limiting (per-tenant) and the
  server-side cache (isolation). Do not deploy this prototype publicly to
  third parties; see `docs/providers.md` for the provider-terms dimension.

## What this is not

This prototype has no authentication, so "per client" rate limiting relies on
`x-forwarded-for` and is trivially spoofable by design. It is a local
laboratory, not a hosted service with privacy guarantees to third parties.
