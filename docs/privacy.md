# Privacy architecture

This document describes exactly what data leaves the client — the browser on
the web/self-hosted build, or the desktop app — per surface and per mode. No
marketing claims: if it is not implemented, it is not promised.

## Core invariant

**Opening a document does NOT send its text to an external TTS provider.**
External transmission starts when the user initiates playback or export. This
invariant holds on both surfaces:

- **Web / self-hosted:** the browser parses and transforms the document
  locally; only spoken chunks are sent to the same-origin `/api/speech`
  route, which forwards them to the configured provider.
- **Desktop (v0.2 beta):** Rust opens the file locally and hands the bytes to
  the WebView for local parsing; on Play, the WebView invokes Rust, which
  talks to a loopback-only local speech sidecar that performs the provider
  call.

## Web / self-hosted data flow

| Mode                | Provider selected                    | Text leaves browser?    | Destination                       | When                          | Play required?                      |
| ------------------- | ------------------------------------ | ----------------------- | --------------------------------- | ----------------------------- | ----------------------------------- |
| Auto (default)      | Server picks best engine             | Yes — spoken chunk text | `/api/speech` → provider          | On synthesis (chunk-by-chunk) | Yes — first Play triggers synthesis |
| Auto + Edge enabled | Edge TTS (unofficial online service) | Yes — spoken chunk text | `/api/speech` → Edge WebSocket    | On synthesis                  | Yes                                 |
| Explicit Edge       | Edge TTS                             | Yes — spoken chunk text | `/api/speech` → Edge WebSocket    | On synthesis                  | Yes                                 |
| Explicit NaN        | NaN/Kokoro                           | Yes — spoken chunk text | `/api/speech` → NaN HTTP endpoint | On synthesis                  | Yes                                 |
| Mock (CI/dev)       | Mock WAV                             | No external call        | `/api/speech` → in-memory mock    | On synthesis                  | Yes                                 |

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

## Desktop data flow (v0.2 beta)

- **Opening:** the document is selected through the OS-native file dialog.
  Rust reads and validates the file (50 MB cap) and hands only the document
  bytes to the WebView, where the same local parsers run as in the web build.
  No provider request occurs during parsing.
- **Playback and export:** the WebView invokes the Rust shell; Rust holds a
  per-process bearer token and talks to the bundled speech sidecar bound to
  loopback (`127.0.0.1`). The sidecar performs the provider call with spoken
  chunk text only; audio returns over the local IPC channel.
- **Secrets:** the optional provider key lives in the OS credential store
  (Windows Credential Manager / macOS Keychain) via the `keyring` crate and
  is never exposed to the WebView.
- **Continuity state:** recents, resume positions and desktop settings are
  persisted in OS app-data (official Tauri store plugin). Recent documents
  store a local path reference plus a content fingerprint — not document
  contents — and reopen verifies the fingerprint before restoring a position.

## Local processing

- **Document parsing (both surfaces):** all formats (PDF, EPUB, DOCX, TXT,
  Markdown, HTML) are parsed locally in the client — the browser on web, the
  desktop WebView on desktop. PDF uses pdf.js, EPUB uses fflate (streaming
  decompression with budget enforcement), DOCX uses mammoth.js + DOMPurify.
  No document bytes leave the client during parsing.
- **Listen transformation:** the spoken-representation rules engine runs
  locally in the client. Numbers, dates, amounts, legal references, and
  abbreviations are verbalized locally.

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

## Speech-service protections (web server and desktop sidecar)

The same speech server implementation powers the web route and the desktop
sidecar, so the following apply on both surfaces:

- Speech requests accept `application/json` only. The request body is read
  incrementally via Web Streams with a byte-level budget
  (`API_MAX_BODY_BYTES`, default 16 KB). Rejection happens while streaming,
  not after full parse.
- Zod validates the body. Text length capped (`SPEECH_MAX_TEXT_CHARS`).
- Logs are structured JSON. Document content is logged only as
  `length:sha256-12-hex` fingerprints. There is a test asserting raw content
  never reaches logs on success or failure.
- Speech operations record structured diagnostics: provider, outcome
  (success/cancelled/timeout/provider_error/queue_rejected), and duration.
  No document text or API keys are logged.
- Rate limiting per client (in-memory sliding window) is a **web/self-hosted
  concern only** — the desktop app talks to its own local sidecar.

## Client-side and local storage

- **Web:** synthesized audio blobs are stored in IndexedDB under
  content-hash keys, for up to **30 days** (best-effort pruning; expired
  entries are treated as cache misses). This is local to the user's browser
  profile; clearing site data removes it. No document text or files are
  persisted client-side; the plan is rebuilt per session from the loaded
  document.
- **Desktop:** continuity state (recents, resume positions, settings) lives
  in OS app-data; provider secrets live in the OS credential store; the
  sidecar's synthesized-audio cache lives in the OS app-data cache directory
  (Rust configures it for the sidecar at startup). Everything stays on the
  user's machine.
- **Server-side audio cache (web/self-hosted):** synthesized audio is cached
  on the server filesystem under `SPEECH_CACHE_DIR` (default `.cache/audio`),
  content-hash keys, LRU eviction at 512 MB. Cache write failures are
  non-fatal — a successful synthesis is returned even if caching fails.

## ZIP archive protection

Parsing-side protections; they apply on both surfaces because the same
document adapters run in the desktop WebView:

- **EPUB (fflate):** Entry count preflight from EOCD record. Per-entry
  `originalSize` gate BEFORE decompression — entries exceeding the budget
  are rejected with 0 bytes allocated. Path traversal detection on entry
  names.
- **DOCX (JSZip):** Metadata preflight: entry count, per-entry uncompressed
  size, total uncompressed size, and compression ratio are checked BEFORE
  inflation. Post-decompression accounting verifies actual inflated bytes.
  JSZip inflates the full entry before our post-decompression check can
  reject — this is a residual risk for metadata-forged DOCX bombs.

## HTTP body protection (web `/api/speech`)

- The speech endpoint reads the request body incrementally via Web Streams.
- Actual received bytes are counted. Rejection happens while streaming,
  not after full body parse.
- Defends against: missing Content-Length, lying Content-Length, chunked
  transfer, oversized payloads.
- On desktop, the WebView→Rust→sidecar transport is loopback-only with a
  per-process bearer token and does not use this public HTTP surface.

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
