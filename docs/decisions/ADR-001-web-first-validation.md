# ADR-001: Web-first validation

- **Status:** accepted
- **Date:** 2026-09-01

## Context

The product hypothesis concerns _listening experience_ and _deterministic
transformation quality_. Both are fastest to validate where documents already
live (browsers), where iteration is instant, and where one maintainer can
operate without app-store or device constraints. Mobile/desktop native builds
multiply surfaces without adding evidence about the hypothesis.

## Decision

Build Phase 0 exclusively for the web: TypeScript + Next.js (App Router) +
React, strict TS, PDF.js client-side extraction, IndexedDB for local audio
cache, server route handlers only where credentials/secrets are required.

- Browser-first parsing keeps documents local (privacy) and the experiment
  loop fast.
- Server-side is a _proxy + cache + pacing_ layer, not an application backend.
- No accounts, no database, no cloud library. State lives in the browser
  session and in local caches.

## Consequences

- (+) Smallest credible surface; a failed hypothesis costs one repo to delete.
- (+) PDF bytes never leave the browser by construction, not by policy.
- (−) Browser extraction is weaker than desktop parsers. This is reframed as
  the _experiment itself_ (gate G2 measures the loss) rather than avoided.
- (−) Heavy layouts (two-column, scanned) will underperform; documented and
  measured instead of hidden.
