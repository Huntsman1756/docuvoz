# Third-party notices

DocuVoz (auidionan) ships, vendors, or references third-party components.
The project's own code is licensed under the Apache License, Version 2.0
([LICENSE](LICENSE)). The components below keep their own licenses and are
**not** relicensed under Apache-2.0.

This file is the single project-level inventory. Vendored code also carries
the required notice **at the vendored location** (see
`src/adapters/document-parsers/vendor/foliate-js/`).

## Vendored source (copied into this repository)

| Component                          | Location                                           | License                  | Upstream                                     | Provenance record                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------- | ------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| foliate-js `epub.js`, `epubcfi.js` | `src/adapters/document-parsers/vendor/foliate-js/` | MIT © 2022 John Factotum | <https://github.com/johnfactotum/foliate-js> | [vendor README](../src/adapters/document-parsers/vendor/foliate-js/README.md) (exact commits, hashes, update procedure); license text shipped next to the files |

Vendored files are unmodified apart from Prettier reformatting; the MIT license
text is included in the vendor directory as required.

## Runtime dependencies (npm)

| Package                                                                                                      | Version                  | License                                           |
| ------------------------------------------------------------------------------------------------------------ | ------------------------ | ------------------------------------------------- |
| `next`, `react`, `react-dom`                                                                                 | 16.3.4 / 19.2.8 / 19.2.8 | MIT                                               |
| `pdfjs-dist` (PDF parsing, incl. worker + standard fonts copied to `public/pdfjs/` by `npm run setup:pdfjs`) | 6.3.289                  | Apache-2.0                                        |
| `jszip` (DOCX loader; also used by Mammoth's dependency tree)                                                | 3.10.1                   | MIT **or** GPL-3.0-or-later (we use it under MIT) |
| `mammoth` (DOCX → semantic HTML)                                                                             | 1.12.2                   | BSD-2-Clause                                      |
| `dompurify` (HTML sanitization)                                                                              | 3.4.14                   | MPL-2.0 or Apache-2.0                             |
| `markdown-it` (Markdown parsing)                                                                             | 15.0.1                   | MIT                                               |
| `mediabunny`, `@mediabunny/mp3-encoder`, `@mediabunny/aac-encoder` (audio export)                            | 1.55.6                   | MPL-2.0                                           |
| `msedge-tts` (Edge neural voices, server-side)                                                               | 2.0.7                    | MIT                                               |
| `idb` (IndexedDB wrapper for audio cache / position persistence)                                             | 8.0.3                    | ISC                                               |
| `zod` (schema validation)                                                                                    | 4.5.4                    | MIT                                               |

### Note on `fflate`

`fflate` is declared in `devDependencies`. However, the EPUB adapter imports it
at runtime (`src/adapters/document-parsers/adapters/epub-adapter.ts`), so it is
included in the client bundle despite the `devDependencies` listing. This is a
packaging inconsistency that should be resolved (move `fflate` to
`dependencies`, or remove the runtime import) before the next release.

## Fonts and assets shipped under `public/`

The pdf.js worker and standard-font data under `public/pdfjs/` are regenerated
at build time from `node_modules/pdfjs-dist` by `scripts/copy-pdf-worker.mjs`
(`npm run setup:pdfjs`). The font data carries two **separately licensed**
components that are **not** Apache-2.0:

- **Foxit PFB fonts** (`Foxit*.pfb`) — distributed under a PDFium BSD-style
  license (see `public/pdfjs/standard_fonts/LICENSE_FOXIT`).
- **Liberation fonts** (`LiberationSans-*.ttf`) — licensed under the
  **GNU General Public License v2 with the font exception** (see
  `public/pdfjs/standard_fonts/LICENSE_LIBERATION`). These are a
  separately-licensed GPLv2+font-exception component and are **not** covered
  by the Apache-2.0 license of this project.

## Trademarks and stock assets

- `public/next.svg`, `public/vercel.svg` (and the related stock assets in
  `public/`) are the stock Next.js template assets. "Next.js" is a trademark of
  Vercel, Inc. and "Vercel" is a trademark of Vercel, Inc. These marks are used
  for identification only; they do not imply endorsement and are not licensed
  under Apache-2.0.

## License compatibility note

Components licensed under **MPL-2.0** (mediabunny and its AAC/MP3 encoders) and
under **GPL-2.0 with the font exception** (Liberation fonts) keep their own
licenses and are **not** relicensed under Apache-2.0. If you redistribute this
project, keep those components' license texts alongside them.

No AGPL components are used. When adding a dependency, add it here with its
license, and ship the license text next to any newly vendored source.
