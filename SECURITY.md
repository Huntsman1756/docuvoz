# Security Policy

## Supported versions

| Version                   | Supported          |
| ------------------------- | ------------------ |
| 0.1.x (Phase 0 prototype) | :white_check_mark: |

This is a research prototype. It is **not** a hardened production service and
is currently intended to run locally or in trusted environments only.

## Reporting a vulnerability

Please report suspected vulnerabilities **privately** through GitHub's
["Report a vulnerability"](../../security/advisories/new) form on this
repository. Do not open a public issue for security problems.

We aim to acknowledge reports within 5 business days. Because this is a
single-maintainer prototype, response times may vary; reports will be handled
in good faith and, where appropriate, credited.

## Design stance

The security model is deliberately narrow (see also [docs/privacy.md](docs/privacy.md)):

- **No secrets in source control.** Credentials live in server-side
  environment variables and are validated at startup. `.env*` is git-ignored;
  only `.env.example` is committed.
- **API keys never reach the browser.** Clients call `/api/speech`; the
  server-side adapter is the only code that knows provider credentials.
  Responses contain stable error codes only — no stack traces, provider
  bodies, or credentials.
- **Documents stay client-side.** Document parsing happens entirely in the
  browser (PDF via pdf.js; EPUB/DOCX/TXT/Markdown/HTML via the document
  adapters). Only short, fidelity-validated _spoken text chunks_ are sent to
  the synthesis endpoint.
- **Input validation at every boundary.** Request bodies are schema-validated
  (zod) with caps on text length and body size. Uploaded files are checked for
  a non-empty file, a 50 MB size limit, and an allowed extension/MIME type
  before parsing. The document adapter dispatch then sniffs the content type
  (first bytes) to select the parser. There is no separate magic-byte
  validation gate; the size/extension/MIME check is the client-side guard,
  and format trust comes from that plus the adapter's own sniffing.
- **Rate limiting.** `/api/speech` is per-client rate limited; the provider
  adapter enforces pacing, bounded retries with backoff and timeouts so
  failures cannot pile up.
- **Log hygiene.** Logs are structured JSON; document content is logged only
  as `length:hash-prefix` fingerprints.

## Notes and caveats

- The prototype runs as a single Next.js process. Rate limiting and dedupe
  state are **in-memory**; running multiple instances requires shared state.
- The filesystem audio cache (`.cache/audio`) stores synthesized speech for
  requests the server has seen. Treat the server host accordingly and do not
  deploy this prototype to multi-tenant infrastructure.
- `SPEECH_PROVIDER=nan` sends the (already normalized, already public-intended)
  chunk text to a third party. Do not use it with confidential documents
  without reviewing the provider's terms.

## Dependency auditing

CI runs `npm audit --omit=dev` on the production dependency tree. Contributors
should run `npm audit` locally after dependency changes and document any
unfixed advisories in the PR.
