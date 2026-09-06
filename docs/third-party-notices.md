# Third-party notices

DocuVoz ships or vendors third-party components. The project's own code is
Apache-2.0-licensed ([LICENSE](../LICENSE)); the components below keep their
own licenses and are not relicensed under Apache-2.0. This file is the
single project-level inventory (the release bundle also carries a copy at
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)); vendored code also
carries the required notice **at the vendored location** (see
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
| `jszip` (DOCX loader; also Mammoth's own dependency)                                                         | 3.10.1                   | MIT **or** GPL-3.0-or-later (we use it under MIT) |
| `mammoth` (DOCX → semantic HTML)                                                                             | 1.12.2                   | BSD-2-Clause                                      |
| `dompurify` (HTML sanitization)                                                                              | 3.4.14                   | MPL-2.0 or Apache-2.0                             |
| `markdown-it` (Markdown parsing)                                                                             | 15.0.1                   | MIT                                               |
| `mediabunny`, `@mediabunny/mp3-encoder`, `@mediabunny/aac-encoder` (audio export)                            | 1.55.6                   | MPL-2.0                                           |
| `msedge-tts` (Edge Read Aloud client, server-side)                                                           | 2.0.7                    | MIT                                               |
| `fflate` (EPUB streaming decompression, runtime dependency)                                                  | 0.8.3                    | MIT                                               |
| `idb`                                                                                                        | 8.0.3                    | ISC                                               |
| `zod`                                                                                                        | 4.5.4                    | MIT                                               |

Standard-font license texts (`LICENSE_FOXIT`, `LICENSE_LIBERATION`) ship in
`public/pdfjs/standard_fonts/` with the files they cover. The Liberation fonts
are licensed under GPL-2.0 with the font exception and are **not** covered by
the Apache-2.0 license of this project.

`public/next.svg`, `public/vercel.svg` (and the other stock assets in `public/`)
are the stock Next.js template assets; "Next.js" and "Vercel" are trademarks of
Vercel, Inc. and are not licensed under Apache-2.0.

No AGPL components are used. When adding a dependency, add it here with its
license, and ship the license text next to any newly vendored source.
