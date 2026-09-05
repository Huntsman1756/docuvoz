# P1 correctness verification

Base: `personal-reader-v0.3`, `3f5b73e66a208af4f7211846613f54dabe5749de`.
The tree was already dirty (21 tracked files and two untracked tests). Existing
reader/player changes were incorporated; research outputs and screenshots were
backed up before gates that regenerate them. No push, merge or branch switch.

## Reproduction and fixes

- F01: a bounded subprocess calling production `planChunks` timed out. The
  absent whitespace boundary was -1, converted into an end offset of zero.
  Negative boundaries now hard-cut, preserving UTF-16 surrogate pairs. Existing
  separator trimming remains; an exact source-span reconstruction check covers
  399/400/401/800/10,000 characters, URL, base64-like, Unicode, punctuation,
  ordinary prose and a million-character stress input.
- F03: all seven initial production-adapter preservation cases failed. Generic
  containers skipped Text nodes; specialized owners excluded descendants that
  no subsequent traversal visited. One `childNodes` traversal now consumes each
  text node once and flushes at structural boundaries. Paragraphs within lists,
  quotes and table cells keep their enclosing semantics. Native DOM parsing and
  DOMPurify remain. Real-sanitizer tests preserve inline adjacency and exclude
  active content. All body content is visited, including outside `article`.
- F04: all eleven repeated semantic categories were muted by the shared pipeline.
  Product-only `buildProductSpokenPlan` disables repetition-only suppression,
  applies an explicit omission decision, and retains uncertain classified text.
  It reuses `validateFidelity`; successful literal validation alone is insufficient
  to authorize deleting prose. Classified page numbers, separators and a small
  explicit set of repeated running-chrome labels are permitted. The research
  pipeline, legal-token definitions, rules and version remain untouched.
- F02: all eight initial controlled-clock tests failed. A single source pointer
  represented both audible and future sources; local offsets were exposed as
  document time; duration knowledge depended on pool residency; paused seeks
  started playback. The contract is in `player-timeline-contract.md`. Additional
  counterexamples cover delayed decode and source creation crossing clock quanta.
  All source nodes are independently owned and invalidated; source-time metadata
  survives buffer eviction; the player passes stored speed on engine creation.
  The longer live smoke exposed one further race: Play during an unfinished
  paused seek started the old position, then seek completion imposed stale pause
  intent. A controlled production-player test reproduced it before the fix.
  Pending seeks now own mutable intent and ignore old-position observations.
  A short real Edge sequence past chunk nine verified all three rate changes.
- F09: installed and locked pdfjs-dist 6.3.289 requires `>=22.13.0 || >=24`;
  jsdom 30.0.1 requires `^22.22.2 || ^24.15.0 || >=26.0.0`. Node 20.9 fails both.
  The supported range is now Node `^24.15.0`; CI pins 24.15.0 with engine-strict
  installation. The optional Windows ia32 Sharp binary requires Node 20, so that
  architecture is explicitly unsupported. No dependency versions changed.

## Truthful test scope

| File / test group                                                             | Classification and repair                                                                                                                                                                                                                                         |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `buffered-player-new`: fetch/cache, errors, preparation, idle lifecycle       | REAL PRODUCTION INVARIANTS, restricted to those paths. Preparation does not prove gapless audio or bounded decoded memory. Overstated titles were narrowed.                                                                                                       |
| `buffered-player-new`: old `scheduleSource` / `scheduleGeneration` tests      | MISLEADING / INSUFFICIENT: they only constructed and destroyed an idle engine. Retained with truthful lifecycle names; actual scheduling/cleanup guarantees are in `audio-timeline`.                                                                              |
| `duration-tolerance`: every test                                              | HELPER/FORMULA TEST. No encoder runs. Renamed the suite and assumed codec-delay examples; corrected a name claiming a failure when its assertion expected success. Actual codec duration tolerance is tested in browser `structural-readback.spec.ts`.            |
| `word-boundary`: tick conversion, JSON failure examples, sorted fixtures      | HELPER/FORMULA TEST. They do not establish provider-stream recovery or runtime synchronization; names now identify examples.                                                                                                                                      |
| `word-boundary`: provider metadata, idle boundary, rate setter, seek, destroy | REAL PRODUCTION INVARIANTS with limited scope. Seek without play intent now expects paused. Boundary installation has an assertion; the no-fetch test now actually calls `setChunkBoundaries`.                                                                    |
| `word-boundary`: prior pause/resume/highlight claims                          | MISLEADING / INSUFFICIENT before repair. Real clock-driven pause/resume/seek/rate boundary coverage is in `audio-timeline`.                                                                                                                                       |
| `cache-reuse`: `blobFor` repetition and rate                                  | REAL PRODUCTION FETCH/BLOB INVARIANTS; does not invoke export encoders. Titles/comments narrowed accordingly.                                                                                                                                                     |
| `cache-reuse`: direct `acquireSynthesis` calls                                | HELPER TEST of that exported helper, not evidence that the product uses global deduplication. The new real-player test connects controls and repeated `blobFor` access to actual fetch calls; browser controls test playback plus MP3 export for all six formats. |
| `buffered-player`: prepared-count test                                        | REAL PRODUCTION INVARIANT. Replaced a flaky 100 ms sleep with the production preparation-completion callback.                                                                                                                                                     |
| `security-inertia`: plain link label                                          | The word “javascript” is harmless text. The test now retains the label while continuing to reject `javascript:` URLs, scripts and handlers.                                                                                                                       |

## Research isolation

The four historical reference fixtures have byte-identical literal and Listen
plans/chunks. The baseline hashes were generated using checkpoint 3f5b73e's
actual chunker, and compared to the fixed chunker before saving. Extraction and
spoken evaluation results match prior results excluding timestamps. The original
untracked corpus-compatibility test remains, with formatting only.

The original `eval:fidelity` command failed because it treated the newly added
EPUB/DOCX manifest entries as PDFs. An isolated historical-only run first proved
zero violations. A production-runner regression then reproduced the failure with
the real manifest. The runner now uses the same reference-backed cohort guard as
extraction/spoken. This changes product-sample routing only: all eight historical
reference/browser reports remain identical. No manifest, rule, threshold, Gold
artifact or historical output was changed. The runner test intercepts only output
writes, so ordinary unit tests cannot overwrite persisted evaluation results.

## Live checks and limits

The existing cold Edge/Ximena browser smoke passed. A separate visible-browser
run used articles 1–12 of the [Spanish Constitution from BOE](https://www.boe.es/buscar/act.php?id=BOE-A-1978-31229).
The final run observed 200 document seconds, ten chunks crossed, one audible native source
at each sample, all sources stopped on pause, silent paused seek, resume, playing
seek and rates 0.75/1.5/2. MP3 export was 12,850,816 bytes and reused 16 chunk
requests without duplication. Estimated duration was 330.13 seconds. Document
switch left zero old scheduled sources and there were no browser page errors.
This is instrumented playback evidence, not an auditory quality judgment.

The configured NaN/Kokoro `ef_dora` short browser smoke played, paused and resumed
without page errors. The first probe incorrectly expected an `x-provider` header
that the API does not return; the corrected probe verified the selected default
engine against health routing and its successful speech response. The server log
also recorded actual NaN synthesis.

## Deferred interactions

- F05: ZIP expansion limits remain unchanged.
- F06: HTTP streaming body limits remain unchanged.
- F07 (FIXED): the Edge cancellation incident was classified as
  **A. EXPECTED CANCELLATION with logging/eviction bug**. The request is
  intentionally aborted; no resource leak; no stale operation. The bug was that
  the abort signal could fire during `clientFor()` (WebSocket connection phase)
  without being detected, causing a missed abort. Additionally, on abort the
  client was evicted (WebSocket closed), but the WebSocket was still valid for
  the next request. The `audioStream.error` handler also misclassified abort-
  caused stream errors as `provider_error` instead of `provider_timeout`.

  Fix: `abortRace()` helper races `clientFor()` against the AbortSignal; a
  post-creation abort check catches the microtask gap; stream error handler
  classifies abort-caused errors as `provider_timeout`; cancellation no longer
  evicts the client (the WebSocket remains valid). 12 new unit tests cover
  all cancellation phases.

  Remaining F07 work (DEFERRED_F07_DEADLINE):
  - QUEUE_DEADLINE: No pacing queue deadline; queued requests wait indefinitely.
  - CONNECT_DEADLINE: WebSocket connection timeout is the library default (~30s
    across 3 retries); no explicit per-phase deadline.
  - FIRST_BYTE_DEADLINE: No first-byte deadline; relies on the global
    `timeoutMs` (5000ms default) covering the entire synthesis.
  - STREAM_DEADLINE: No per-stream deadline; the global `timeoutMs` covers
    from stream creation to completion.

- F08: privacy/retention, cache architecture and export StreamTarget remain unchanged.

Review was performed sequentially by the same agent, including a second pass
restricted to production playback state and counterexamples. It was not an
independent-context review and used no assistant-created subagents.

## Working-tree ownership

Pre-existing tracked changes (preserved):

- Nine screenshots: desktop-1440x900, desktop-1920x1080 and mobile-390, each
  with 02-listening, 03-literal-toc and 04-playing under docs/screenshots.
- evaluation/experiments/g4b/review-packet.csv; evaluation/results/extraction.json;
  evaluation/results/spoken.json.
- playwright.config.ts; src/adapters/speech-providers/mock-provider.ts;
  src/components/reader.tsx; src/lib/buffered-audio-engine.ts;
  src/lib/buffered-player.ts; src/server/config.ts.
- tests/e2e/edge-smoke.spec.ts; tests/e2e/live-edge-export.spec.ts;
  tests/e2e/reader.spec.ts.

Pre-existing untracked tests: tests/e2e/cold-edge-smoke.spec.ts and
tests/unit/eval-corpus-compat.test.ts. Only formatting was applied to them.
The screenshots and evaluation outputs were restored byte-for-byte from their
pre-gate backups, preserving the original dirty versions.

Task edits/additions:

- Runtime: .github/workflows/ci.yml, README.md, package.json, package-lock.json.
- Production: src/domain/spoken/speech-plan.ts;
  src/adapters/document-parsers/adapters/html-adapter.ts;
  src/adapters/speech-providers/edge-provider.ts;
  src/lib/product-spoken-plan.ts; src/lib/buffered-audio-engine.ts;
  src/lib/buffered-player.ts; src/components/reader.tsx.
- Evaluation harness: evaluation/scripts/run-fidelity-eval.ts.
- Documentation: docs/player-timeline-contract.md; docs/p1-verification-notes.md.
- Added tests: tests/e2e/player-controls.spec.ts; tests/unit/audio-timeline.test.ts;
  tests/unit/chunk-termination.test.ts; tests/unit/edge-cancellation.test.ts;
  tests/unit/html-preservation.test.ts;
  tests/unit/product-omission.test.ts; tests/unit/node-contract.test.ts;
  tests/unit/research-output-compat.test.ts; tests/unit/research-compat-hashes.json;
  tests/unit/fidelity-runner-compat.test.ts.
- Repaired tests: tests/unit/adapter-contract.test.ts;
  tests/unit/buffered-player-new.test.ts; tests/unit/buffered-player.test.ts;
  tests/unit/cache-reuse.test.ts; tests/unit/duration-tolerance.test.ts;
  tests/unit/security-inertia.test.ts; tests/unit/word-boundary.test.ts.

## Final gates (local Node 24.19.0)

- npm test: 505 passed, one opt-in live integration test skipped.
- npm run typecheck: passed.
- npm run lint: passed; 0 errors, 0 warnings.
- npm run format:check: passed.
- npm run build: passed.
- npm run test:e2e: 61 passed, retries 0.
- Extraction/spoken/fidelity evaluation: passed; historical metrics unchanged.
- TTS wiring: 11/11 passed. Controlled audio timeline: 17 passed.
- Edge cancellation lifecycle: 12/12 passed.
- Final Edge run and configured NaN smoke passed their instrumented assertions.

## Human auditory checklist (deterministic, for manual verification)

Use the existing real Edge/Ximena smoke document or another representative
Spanish document. The human only needs to verify:

1. No audible gap between chunks.
2. No duplicated word/phrase at chunk boundary.
3. No clipped beginning/end of chunk.
4. Pause gives actual silence.
5. Resume does not repeat/skip text.
6. Seek while paused remains silent.
7. Seek while playing starts at sensible target.
8. 0.75x sounds continuous.
9. 1.5x sounds continuous.
10. 2x does not produce scheduler overlap.
11. Switch document stops old voice completely.

This is a HUMAN_ACCEPTANCE gate, not CI. Do not block automated verification
waiting for subjective feedback.
