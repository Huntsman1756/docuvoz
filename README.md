# AUIDIO NAN — DocuVoz, a document-to-audio reader

**AUIDIO NAN** (product name: **DocuVoz**) is an audio-first document reader.
It turns PDF, EPUB, DOCX, TXT, Markdown, and HTML documents into spoken audio
that you can listen to, control, resume, and export — on desktop and mobile.

License: [Apache-2.0](LICENSE)

## What it does

- **Multi-format ingestion** — PDF, EPUB, DOCX, TXT, Markdown, and HTML are
  parsed locally in the browser. Maximum upload size: **50 MB**.
- **Audio-first reading** — press Play and the reader narrates the document.
  The source text is shown alongside playback, with the current segment
  highlighted and auto-scrolled.
- **Transport controls** — play/pause, previous/next fragment, seek
  forward/backward (30 s / 15 s), a seek bar, and a listen-time estimate.
- **Resume** — your position in each document is remembered (per browser
  profile) so you can pick up where you left off.
- **Repeat** — repeat the current fragment or the whole document
  (off / one / all).
- **Playback speed** — 0.75× to 2×.
- **Keyboard shortcuts** — Space (play/pause), `←`/`→` (seek),
  `Shift+←`/`Shift+→` (previous/next fragment), `Shift+↑`/`Shift+↓` (speed),
  `R` (repeat), `E` (export).
- **Export** — download the narrated document as **WAV**, **MP3**, or
  **M4A**.
- **Mobile support** — responsive layout for phones and small screens.
- **Spanish & English** — language can be auto-detected or chosen, and
  voices/engines are selected per language.

## Speech engines

Synthesis is driven by a server-side provider; the browser only ever sees an
opaque engine id. The default engine is a **local mock** (deterministic WAV,
no network) used for offline work and tests, or **NaN/Kokoro** when you set
`SPEECH_PROVIDER=nan`. An optional **Edge TTS** engine (free Microsoft neural
voices, strong Spanish) can be enabled with `EDGE_TTS_ENABLED=true`.

```bash
# .env.local — default is mock, no credentials needed
SPEECH_PROVIDER=nan            # optional: use NaN/Kokoro instead of mock
NAN_BASE_URL=https://<endpoint>/v1
NAN_API_KEY=<server-only; never reaches the browser>
NAN_TTS_MODEL=kokoro
NAN_TTS_VOICE=<a Spanish-capable voice>
EDGE_TTS_ENABLED=true          # optional second engine (Edge TTS)
```

See [docs/providers.md](docs/providers.md) for the provider contract and the
terms you must review before using NaN/Kokoro with anything beyond personal
validation.

## Privacy

Document parsing happens entirely in the browser. The original document never
leaves the browser: only short, already-normalized **spoken chunks** go to
your own `/api/speech` endpoint, and from there to the configured TTS
provider. **No document text is sent to a TTS provider until you press Play
(or start an export).** With the default `mock` provider there is **no
network call at all**. Full details: [docs/privacy.md](docs/privacy.md).

## Quick start

Requires Node 24 LTS, minimum 24.15.0 (supported range: 24.x). npm is the
only supported package manager. Use a 64-bit Node installation; Windows ia32
is unsupported.

```bash
git clone <this-repo>
cd auidionan
npm ci
cp .env.example .env.local     # works as-is: provider=mock, no credentials
npm run dev                    # http://localhost:3000
```

Open the app, drop a document (or click an example), and press **Escuchar**.
You can switch between **Escuchar** (Listen) and **Literal** (verbatim)
reading, choose the language, and adjust the voice/engine in the advanced
options. The **Laboratorio** page (`/lab`) exposes the lower-level
experimentation surface and provenance inspection.

## Commands

| Command                                       | What it does                                                |
| --------------------------------------------- | ----------------------------------------------------------- |
| `npm test`                                    | unit + golden + integration tests (mock provider, offline)  |
| `npm run lint` / `typecheck` / `format:check` | static checks                                               |
| `npm run build`                               | production build                                            |
| `npm run test:e2e`                            | Playwright critical-path tests (CI-safe, mock provider)     |
| `npm run setup:pdfjs`                         | regenerate `public/pdfjs/` (pdf.js worker + standard fonts) |
| `npm run test:provider:live`                  | opt-in live NaN wiring check (local only)                   |

## Architecture (tour)

```text
src/
  domain/           pure logic: documents, spoken rules + fidelity, speech
                    contract, provenance          (no framework, no I/O)
  adapters/         document-parsers (pdf.js) · speech-providers (nan, mock, edge, pacing)
  infrastructure/   audio cache keys, filesystem cache, structured logging
  server/           env validation, rate limiting, framework-agnostic handler
  app/              Next.js routes (thin wrappers) + reader/lab UI
  lib/              ingestion guards, export, buffered player, position persistence
tests/              unit · golden · integration · e2e · fixtures
docs/               architecture, privacy, providers, ADRs, third-party notices
```

Deep dive: [docs/architecture.md](docs/architecture.md) ·
[docs/document-model.md](docs/document-model.md) ·
[docs/privacy.md](docs/privacy.md)

## Limitations (honest list)

- Browser extraction is text-layer based: scanned PDFs without a text layer
  cannot be read, and some complex layouts (e.g. two-column, dense tables)
  may not be reproduced perfectly. This is measured, not hidden.
- The committed example corpus is **synthetic**; it is a stand-in for the
  target document types, not live regulatory filings.
- Rate limiting and cache state are **in-memory** + single-process: this is
  **not** a public multi-tenant service. Do not deploy as-is.
- Real TTS (NaN/Kokoro, Edge TTS) is provider-dependent. Generated audio is
  governed by the provider's terms, not this license, and model weights are
  **not** redistributed by this repository.
- **Legal note:** this project reads documents aloud; it is not legal or
  financial advice, and no automated check certifies semantic faithfulness.

## Contributing

Read [CONTRIBUTING.md](CONTRIBUTING.md), then open an issue or PR.
Security reports: [SECURITY.md](SECURITY.md). Community:
[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md). History: [CHANGELOG.md](CHANGELOG.md).

## License

Apache-2.0 — see [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md). Third-party
runtime components (pdf.js, Next.js, React, JSZip, Mammoth, DOMPurify,
markdown-it, `idb`, `zod`, mediabunny, `msedge-tts`) and the vendored
foliate-js EPUB parser keep their own licenses; the full inventory, versions,
and vendoring provenance live in
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (also at
[docs/third-party-notices.md](docs/third-party-notices.md)). Note that the
MPL-2.0 mediabunny library and the GPL-2.0+font-exception Liberation fonts are
**not** relicensed under Apache-2.0. Model weights and audio from real
providers are governed by **their** terms, not this license. Generated TTS
audio is **not** redistributed in this repository.
