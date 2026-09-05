# Third-party notices

DocuVoz ships or vendors third-party components. The project's own code is
MIT-licensed ([LICENSE](../LICENSE)); the components below keep their own
licenses. This file is the single project-level inventory; vendored code also
carries the required notice **at the vendored location** (see
`src/adapters/document-parsers/vendor/foliate-js/`).

## Vendored source (copied into this repository)

| Component                          | Location                                           | License                  | Upstream                                     | Provenance record                                                                                                                                               |
| ---------------------------------- | -------------------------------------------------- | ------------------------ | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| foliate-js `epub.js`, `epubcfi.js` | `src/adapters/document-parsers/vendor/foliate-js/` | MIT © 2022 John Factotum | <https://github.com/johnfactotum/foliate-js> | [vendor README](../src/adapters/document-parsers/vendor/foliate-js/README.md) (exact commits, hashes, update procedure); license text shipped next to the files |

Vendored files are unmodified apart from Prettier reformatting; the MIT license
text is included in the vendor directory as required.

## Runtime dependencies (npm)

| Package                                                                                                      | License                                           |
| ------------------------------------------------------------------------------------------------------------ | ------------------------------------------------- |
| `next`, `react`, `react-dom`                                                                                 | MIT                                               |
| `pdfjs-dist` (PDF parsing, incl. worker + standard fonts copied to `public/pdfjs/` by `npm run setup:pdfjs`) | Apache-2.0                                        |
| `jszip` (EPUB loader; also Mammoth's own dependency)                                                         | MIT **or** GPL-3.0-or-later (we use it under MIT) |
| `mammoth` (DOCX → semantic HTML)                                                                             | BSD-2-Clause                                      |
| `dompurify` (HTML sanitization)                                                                              | MPL-2.0 or Apache-2.0                             |
| `markdown-it` (Markdown parsing)                                                                             | MIT                                               |
| `mediabunny`, `@mediabunny/mp3-encoder`, `@mediabunny/aac-encoder` (audio export)                            | MPL-2.0                                           |
| `msedge-tts` (Edge neural voices, server-side)                                                               | MIT                                               |
| `idb`                                                                                                        | ISC                                               |
| `zod`                                                                                                        | MIT                                               |

Standard-font license texts (`LICENSE_FOXIT`, `LICENSE_LIBERATION`) ship in
`public/pdfjs/standard_fonts/` with the files they cover.

No AGPL components are used. When adding a dependency, add it here with its
license, and ship the license text next to any newly vendored source.
