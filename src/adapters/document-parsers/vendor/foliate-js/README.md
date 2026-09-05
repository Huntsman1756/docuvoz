# Vendored: foliate-js EPUB parser

This directory contains an unmodified copy of two source files from
[foliate-js], used by the EPUB document adapter
(`src/adapters/document-parsers/adapters/epub-adapter.ts`).

## Provenance

```text
UPSTREAM:        https://github.com/johnfactotum/foliate-js
UPSTREAM_COMMIT: ab5abb9dd4a60d81a5890096351f35dfa952e0eb   (epub.js,   2026-03-05 "EPUB: Add pageBreakSource metadata property (#109)")
                 399248a67a8862ffb5e6463a33f9d52b317ca2eb   (epubcfi.js, 2026-03-05 "Run `eslint --fix`")
LICENSE:         MIT (John Factotum, 2022) — full text in ./LICENSE (byte-identical to upstream LICENSE, blob 5930571b73151702a913179ef5f96313ad7d25d3)
LOCAL_MODIFICATIONS:
  NONE SEMANTIC. Both files are byte-different from upstream only because they
  were reformatted with this project's Prettier config (printWidth 90; upstream
  uses its own Prettier settings). After normalizing both sides through this
  project's Prettier, each vendored file is byte-identical to the corresponding
  upstream file. There are zero functional edits, zero added or removed code.
UPDATE_PROCEDURE:
  1. Pick the upstream commit to adopt and read its history since the recorded
     commit (github.com/johnfactotum/foliate-js/commits/main/epub.js).
  2. Download epub.js / epubcfi.js from that commit.
  3. Replace the files here and run `npx prettier --write src/adapters/document-parsers/vendor/foliate-js`
     so the tree stays `npm run format:check` clean.
  4. Verify semantic identity of any retained file with:
     `npx prettier <upstream-file> | git hash-object --stdin` compared against
     `git hash-object` of the same command on the local file (see hash table below).
  5. Run `npm test` (EPUB adapter + contract suites) and `npm run test:e2e`.
  6. Update UPSTREAM_COMMIT and the hash table in this file.
  Never edit these files in place. If a change to parser behavior is needed, fix
  it in the adapter layer or maintain an explicit patch series documented here.
```

## File hashes

| File          | Vendored (git blob)                      | Vendored (SHA-256)                                                           | Upstream raw (SHA-256)                                                       | After Prettier(project) — both sides (`git blob`) |
| ------------- | ---------------------------------------- | ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------- |
| `epub.js`     | `0cfc721820c308355b10a34d2706e3a755d91eff` | `f0aa4136f84847ad94f41c58ec906cca3ccd1a892d7418739ab59fe2a2740f15`             | `dfe347495039e9b5991478986ec6b7713cf9efbcd8f475a77ef7b967c5176298` (ab5abb9d) | `feb3cea20e8873253d3283069a93588df3f4b944` ≡      |
| `epubcfi.js`  | `bc9dcfbbc7c67b34225ec8eab1a70427f350b0b4` | `0cfb75c04ac6db148f79db8d843b8577ec59fb9fd6145c451ce109ea6dc9e086`             | `e1a688ad5c84bf31f33cef467f92c7a6d060a0f17ec37c1d3c048e9c7b1cf645` (399248a6) | `03cbb04f085d942a7c14db872ea415009456b8ae` ≡      |
| `LICENSE`     | `5930571b73151702a913179ef5f96313ad7d25d3` | `b621ffc351fe263bc9b09dd0bc1c9332fda9c462a3904c1e4f0b4d3236b9c28c`             | identical (byte-for-byte)                                                    | n/a                                               |

(`≡` = identical hash on both sides after normalization ⇒ content identical modulo
formatting.)

Non-upstream files in this directory, owned by this project: `README.md` (this
file) and `epub.d.ts` (minimal type declarations for our adapter's usage).

## Why the ZIP loader is ours (JSZip) and not a vendored zip.js wrapper

foliate-js deliberately ships **no** archive reader: `epub.js` accepts a
`loader` object (`loadText`/`loadBlob`/`getSize`) and the upstream README states
"Reading Zip-based formats requires adapting an external library"; upstream's
demo `view.js` happens to use [zip.js]. We implement the same documented
interface over **JSZip** in `epub-adapter.ts`, keeping the parser untouched.

Decision rationale (re-evaluated 2026-09-05):

- **Footprint:** JSZip (≈98 KB min, ≈35 KB gzip) is already a hard runtime
  dependency of Mammoth (DOCX), so it is in every bundle path regardless.
  `@zip.js/zip.js` would be a *new* dependency with a similar size.
- **Sufficient interface:** we need three methods over a local ≤50 MB `File`.
  zip.js's differentiator — random access to `File`/HTTP ranges — only pays off
  for very large books or streamed OPDS downloads, neither of which DocuVoz
  handles (documents are parsed fully locally, ≤50 MB cap).
- **Safety-limit metadata:** JSZip parses the ZIP central directory during
  `loadAsync`, so per-entry uncompressed sizes are available *before* any
  inflation (`_data.uncompressedSize`), which is what the adapter-level
  resource-exhaustion limits (see `zip-limits.ts`) rely on. zip.js offers the
  same via `GET_ENTRY_INFO`, so neither library has a correctness edge here.
- **Integrity:** JSZip validates CRC-32 while inflating; failures reject the
  entry promise and the adapter skips/fails the section.
- **Compatibility:** both are well-supported in evergreen browsers; JSZip is
  the more battle-tested in Node (same code runs in our jsdom test setup).
- **Maintenance:** both libraries are mature and slow-moving. Keeping one ZIP
  library across EPUB and DOCX reduces surface area.

If DocuVoz ever needs streamed/ranged archive access (multi-hundred-MB books,
OPDS), swap the loader implementation in `epub-adapter.ts` to `@zip.js/zip.js`
(BSD-3-Clause, add a NOTICE entry). The vendored parser does not change.

[foliate-js]: https://github.com/johnfactotum/foliate-js
[zip.js]: https://github.com/gildas-lormeau/zip.js
