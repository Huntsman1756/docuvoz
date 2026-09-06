# Privacy architecture

This document describes exactly what data leaves the browser, per mode. No
marketing claims: if it is not implemented, it is not promised.

## Core invariant

**Opening a document does NOT send its text to an external TTS provider.**
External transmission starts when the user initiates playback or export.

## Routing matrix

| Mode                | Provider selected        | Text leaves browser?    | Destination                       | When                          | Play required?                      |
| ------------------- | ------------------------ | ----------------------- | --------------------------------- | ----------------------------- | ----------------------------------- |
| Auto (default)      | Server picks best engine | Yes — spoken chunk text | `/api/speech` → provider          | On synthesis (chunk-by-chunk) | Yes — first Play triggers synthesis |
| Auto + Edge enabled | Edge TTS (unofficial online service) | Yes — spoken chunk text | `/api/speech` → Edge WebSocket | On synthesis | Yes |
| Explicit Edge       | Edge TTS                 | Yes — spoken chunk text | `/api/speech` → Edge WebSocket    | On synthesis                  | Yes                                 |
| Explicit NaN        | NaN/Kokoro               | Yes — spoken chunk text | `/api/speech` → NaN HTTP endpoint | On synthesis                  | Yes                                 |
| Mock (CI/dev)       | Mock WAV                 | No external call        | `/api/speech` → in-memory mock    | On synthesis                  | Yes                                 |

**What is transmitted:** Each spoken chunk (≈400 chars of transformed text)
is sent to `/api/speech` on the same origin. The server forwards it to the
configured provider. The original document never leaves the browser.

**When synthesis happens:** Only when the user presses Play. Opening a
document parses and transforms locally — no network requests. Pressing Play
triggers on-demand synthesis of the current chunk, then bounded prefetch
(2 chunks ahead) runs during playback.

**No eager preparation:** `prepare()` is NOT called on document load.
The Play button starts synthesis. If the first chunk isn't ready when Play
is pressed, the user sees "Preparando audio..." while synthesis runs.

## Local processing

- **Document parsing:** All formats (PDF, EPUB, DOCX, TXT, Markdown, HTML)
  are parsed entirely in the browser. PDF uses pdf.js, EPUB uses fflate
  (streaming decompression with budget enforcement), DOCX uses mammoth.js
  - DOMPurify. No document bytes leave the browser.
- **Listen transformation:** The spoken-representation rules engine runs
  entirely in the browser. Numbers, dates, amounts, legal references, and
  abbreviations are verbalized locally.
- **Cache (client):** Synthesized audio blobs are stored in IndexedDB under
  content-hash keys. Retention: **30 days**. Expired entries are treated as
  cache misses on read. Background pruning removes expired entries (bounded
  to 200 entries per sweep).
- **Cache (server):** Synthesized audio is cached on the server filesystem
  under `SPEECH_CACHE_DIR`. Content-hash keys. LRU eviction at 512 MB.
  Cache write failures are non-fatal — a successful synthesis is returned
  even if caching fails.

## External processing

- **Edge TTS:** Optional, unofficial, best-effort integration with Microsoft
  Edge's online Read Aloud service (WebSocket endpoint). No API key required.
  Availability is not guaranteed and the service may change or stop working
  without notice. Text is sent as SSML (XML-escaped).
  Word boundary metadata is received alongside audio.
- **NaN/Kokoro:** OpenAI-compatible `/audio/speech` endpoint. Requires
  `NAN_BASE_URL` and `NAN_API_KEY`. Text is sent as JSON. Audio is
  returned as the configured format.

Both providers receive only the spoken chunk text — never the full document,
never the original file.

## Server-side handling

- `/api/speech` accepts `application/json` only. The request body is read
  incrementally via Web Streams with a byte-level budget (`API_MAX_BODY_BYTES`,
  default 16 KB). Rejection happens while streaming, not after full parse.
- Zod validates the body. Text length capped (`SPEECH_MAX_TEXT_CHARS`).
- Rate limiting per client (in-memory sliding window).
- Logs are structured JSON. Document content is logged only as
  `length:sha256-12-hex` fingerprints. There is a test asserting raw content
  never reaches logs on success or failure.
- Speech operations record structured diagnostics: provider, outcome
  (success/cancelled/timeout/provider_error/queue_rejected), and duration.
  No document text or API keys are logged.

## Client-side storage

- **IndexedDB** (`auidionan-audio`) stores synthesized audio blobs under
  content-hash keys, for up to **30 days** (best-effort pruning). Expired
  entries are treated as cache misses. This is local to the user's browser
  profile. Clearing site data removes it.
- No document text or PDFs are persisted client-side; the plan is rebuilt per
  session from the loaded document.

## ZIP archive protection

- **EPUB (fflate):** Entry count preflight from EOCD record. Per-entry
  `originalSize` gate BEFORE decompression — entries exceeding the budget
  are rejected with 0 bytes allocated. Path traversal detection on entry
  names.
- **DOCX (JSZip):** Metadata preflight: entry count, per-entry uncompressed
  size, total uncompressed size, and compression ratio are checked BEFORE
  inflation. Post-decompression accounting verifies actual inflated bytes.
  JSZip inflates the full entry before our post-decompression check can
  reject — this is a residual risk for metadata-forged DOCX bombs.

## HTTP body protection

- The speech endpoint reads the request body incrementally via Web Streams.
- Actual received bytes are counted. Rejection happens while streaming,
  not after full body parse.
- Defends against: missing Content-Length, lying Content-Length, chunked
  transfer, oversized payloads.

## Operation deadlines

- One coherent deadline (`DEADLINE.TOTAL_MS`, 60s) governs the entire
  synthesis operation via `DeadlineWrapper` around the provider.
- Cancellation interrupts the operation. Client cancellation is classified
  as `cancelled` (499), not as a provider error.

## Backoff and retry

- Local bounded exponential backoff with jitter (not Retry-After).
- Max attempts: 3 (configurable via `SPEECH_MAX_ATTEMPTS`).
- Base delay: 500ms, max delay: 8s.
- Retry-After headers from providers are NOT parsed.

## Deferred (documented, not implemented)

- Adapted (LLM) mode: when it exists it must obtain explicit opt-in, disclose
  that content leaves to a model provider, and preserve original/spoken
  separation. It is not implemented.
- Multi-user deployments require reworking rate limiting (per-tenant) and the
  server-side cache (isolation). Do not deploy this prototype publicly to
  third parties; see `docs/providers.md` for the provider-terms dimension.

## What this is not

This app has no authentication, so "per client" rate limiting relies on
`x-forwarded-for` and is trivially spoofable by design. It is intended for
local or self-hosted use, not as a hosted service with privacy guarantees to
third parties.
