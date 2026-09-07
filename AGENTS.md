<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes â€” APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` â€” verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# Agent & contributor guide

## Project

DocuVoz is an open-source audio-first document reader (Next.js web + Tauri desktop with a Node speech sidecar). Node ^24.15.0, npm, TypeScript.

## Structure

`src/` (web app), `desktop/` (desktop entry routes), `sidecar/` (Node 24 sidecar: esbuild bundle + pkg packaging), `src-tauri/` (Tauri shell; common bundle config in tauri.conf.json, platform targets only in tauri.windows.conf.json and tauri.macos.conf.json), `scripts/` (build/verify tooling), `evaluation/` (eval harness), `docs/` (architecture, privacy, providers, ADRs).

## Verification

`npm run typecheck`; `npm run lint`; `npm run format:check`; `npm run test` (pretest builds the sidecar); `npm run test:e2e`; `npm run build`.

## Conventions

- Small coherent changes.
- CI must stay green (no skipping/weakening checks).
- Update `docs/` when behavior changes.
- Never commit credentials (`.env*` ignored, `.env.example` is the template).
- Do not modify the frozen research baseline (`docs/phase-0.md`, `evaluation/` historical artifacts, `docs/decisions/`) without an ADR.
- Do not alter the sidecar architecture or the platform bundle-target convention without a documented decision.
- Prefer reuse over new dependencies and record provenance in `THIRD_PARTY_NOTICES.md`.
