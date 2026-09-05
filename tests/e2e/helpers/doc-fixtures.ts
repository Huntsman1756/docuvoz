/**
 * Deterministic document fixture builders (EPUB / DOCX) for E2E, unit and
 * performance tests.
 *
 * All content is synthetic original text written for this project — no
 * copyrighted books are used. Every archive is byte-deterministic: JSZip
 * entries carry a fixed timestamp and fixed compression settings, so
 * generated fixtures have stable SHA-256 across runs and machines.
 */
import JSZip from "jszip";

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface FixtureFile {
  name: string;
  mimeType: string;
  buffer: Buffer;
}

export function asFile(f: FixtureFile): File {
  return new File([new Uint8Array(f.buffer)], f.name, { type: f.mimeType });
}

export interface EpubChapter {
  /** Filename inside OEBPS/, e.g. "chap1.xhtml". */
  file: string;
  title: string;
  /** Raw XHTML body markup (injected verbatim — keep valid XML!). */
  body: string;
  /** Extra <head> markup (stylesheets, scripts for threat fixtures). */
  head?: string;
  /** Spine linear="no" */
  nonLinear?: boolean;
  /** manifest properties, e.g. "svg" */
  properties?: string;
}

export interface EpubTocEntry {
  label: string;
  /** href relative to the OPF, e.g. "chap1.xhtml" or "chap1.xhtml#s2" */
  href: string;
  children?: EpubTocEntry[];
}

export interface EpubBuildOptions {
  name?: string;
  title?: string | null;
  authors?: string[];
  language?: string;
  /** 2 → NCX toc; 3 → nav document (default 3). */
  version?: 2 | 3;
  /** spine page-progression-direction. */
  rtl?: boolean;
  chapters: EpubChapter[];
  /** null → no TOC at all. */
  toc?: EpubTocEntry[] | null;
  /** Raw extra zip entries (path traversal tests, stray files). */
  extraEntries?: Record<string, string | Uint8Array>;
  /** Raw META-INF/encryption.xml content (DRM signalling). */
  encryptionXml?: string;
  /** Write an invalid container.xml. */
  breakContainer?: boolean;
  /** Write a truncated OPF. */
  breakOpf?: boolean;
  /** rendition:layout = pre-paginated. */
  fixedLayout?: boolean;
  /** Emit cover-image metadata + a real embedded PNG (in-book, no network). */
  withCover?: boolean;
}

const ZIP_DATE = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

/**
 * JSZip auto-creates implicit directory entries whose date defaults to
 * `new Date()` — pin every entry (dirs included) to a fixed timestamp so
 * archives are byte-reproducible across processes and machines.
 */
function pinEntryDates(zip: JSZip): void {
  for (const entry of Object.values(zip.files)) {
    const data = (entry as unknown as { _data?: { date?: Date } })._data;
    if (data) data.date = ZIP_DATE;
  }
}

const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

function xml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function xhtmlChapter(ch: EpubChapter, lang: string): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${lang}">
<head><title>${xml(ch.title)}</title>${ch.head ?? ""}</head>
<body>
${ch.body}
</body>
</html>`;
}

function navDocument(toc: EpubTocEntry[]): string {
  const render = (items: EpubTocEntry[]): string =>
    `<ol>${items
      .map(
        (t) =>
          `<li><a href="${t.href}">${xml(t.label)}</a>${t.children ? render(t.children) : ""}</li>`,
      )
      .join("")}</ol>`;
  return `<?xml version="1.0" encoding="utf-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><title>Índice</title></head>
<body>
<nav epub:type="toc"><h1>Índice</h1>${render(toc)}</nav>
</body>
</html>`;
}

function ncxDocument(uid: string, toc: EpubTocEntry[]): string {
  let playOrder = 0;
  const render = (items: EpubTocEntry[]): string =>
    items
      .map((t) => {
        playOrder += 1;
        const me = playOrder;
        return `<navPoint id="np${me}" playOrder="${me}"><navLabel><text>${xml(t.label)}</text></navLabel><content src="${t.href}"/>${t.children ? render(t.children) : ""}</navPoint>`;
      })
      .join("");
  return `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${uid}"/><meta name="dtb:depth" content="2"/></head>
  <docTitle><text>Índice</text></docTitle>
  <navMap>${render(toc)}</navMap>
</ncx>`;
}

function opfDocument(
  o: Required<Pick<EpubBuildOptions, "version">> & EpubBuildOptions,
): string {
  const authors = (o.authors ?? [])
    .map((a) => `<dc:creator id="creator${authorsCounter(a)}">${xml(a)}</dc:creator>`)
    .join("");
  const metadataExtra = [
    o.fixedLayout ? `<meta property="rendition:layout">pre-paginated</meta>` : "",
    o.withCover ? `<meta property="cover">cover-image</meta>` : "",
  ].join("");
  const navManifest =
    o.version === 3 && o.toc
      ? `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>`
      : "";
  const navSpineId = o.version === 3 && o.toc ? ` toc="nav"` : o.toc ? ` toc="ncx"` : "";
  const ncxManifest =
    o.version === 2 && o.toc
      ? `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>`
      : "";
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${o.version}.0" xml:lang="${o.language}" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:docuviz-fixture-0001</dc:identifier>
    ${o.title ? `<dc:title>${xml(o.title)}</dc:title>` : ""}
    ${authors}
    ${o.language ? `<dc:language>${o.language}</dc:language>` : ""}
    ${metadataExtra}
  </metadata>
  <manifest>
    ${navManifest}
    ${ncxManifest}
    ${o.withCover ? `<item id="cover-image" href="cover.png" media-type="image/png"/>` : ""}
    ${o.chapters
      .map(
        (c, i) =>
          `<item id="chap${i}" href="${c.file}" media-type="application/xhtml+xml"${c.properties ? ` properties="${c.properties}"` : ""}/>`,
      )
      .join("\n    ")}
  </manifest>
  <spine page-progression-direction="${o.rtl ? "rtl" : "ltr"}"${navSpineId}>
    ${o.chapters
      .map((c, i) => `<itemref idref="chap${i}"${c.nonLinear ? ' linear="no"' : ""}/>`)
      .join("\n    ")}
  </spine>
</package>`;
}

// Deterministic creator ids (no Date/random).
function authorsCounter(a: string): number {
  let h = 0;
  for (let i = 0; i < a.length; i++) h = (h * 31 + a.charCodeAt(i)) % 1000;
  return h;
}

export async function buildEpub(options: EpubBuildOptions): Promise<FixtureFile> {
  const o = {
    name: "sample.epub",
    title: "Sample",
    authors: [] as string[],
    language: "es",
    version: 3 as const,
    toc: null as EpubTocEntry[] | null,
    ...options,
  };
  const zip = new JSZip();

  // mimetype must be the first entry, STORED, exact string.
  zip.file("mimetype", "application/epub+zip", {
    compression: "STORE",
    date: ZIP_DATE,
  });
  zip.file(
    "META-INF/container.xml",
    o.breakContainer
      ? '<?xml version="1.0"?><container THIS IS NOT XML'
      : `<?xml version="1.0" encoding="utf-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
    { date: ZIP_DATE },
  );
  if (o.encryptionXml) {
    zip.file("META-INF/encryption.xml", o.encryptionXml, { date: ZIP_DATE });
  }

  const opf = opfDocument(o);
  zip.file("OEBPS/content.opf", o.breakOpf ? opf.slice(0, 120) : opf, {
    date: ZIP_DATE,
  });

  for (const ch of o.chapters) {
    zip.file(`OEBPS/${ch.file}`, xhtmlChapter(ch, o.language), {
      date: ZIP_DATE,
    });
  }
  if (o.toc && o.version === 3) {
    zip.file("OEBPS/nav.xhtml", navDocument(o.toc), { date: ZIP_DATE });
  }
  if (o.toc && o.version === 2) {
    zip.file("OEBPS/toc.ncx", ncxDocument("urn:uuid:docuviz-fixture-0001", o.toc), {
      date: ZIP_DATE,
    });
  }
  if (o.withCover) zip.file("OEBPS/cover.png", PNG_1PX, { date: ZIP_DATE });
  for (const [path, content] of Object.entries(o.extraEntries ?? {})) {
    zip.file(path, content, { date: ZIP_DATE });
  }

  pinEntryDates(zip);
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return { name: o.name, mimeType: "application/epub+zip", buffer };
}

/* ------------------------------------------------------------------ */
/*  Canonical benign EPUB (3 chapters, nested TOC, list, table, note)  */
/* ------------------------------------------------------------------ */

export const SAMPLE_EPUB_MARKERS = {
  title: "Aventuras de DocuVoz",
  author: "Ana Ejemplo",
  chap1Heading: "Capítulo 1: El origen",
  chap1Text: "El faro de DocuVoz parpadeaba sobre el puerto dormido.",
  chap2Heading: "Capítulo 2: La travesía",
  chap2Text: "Navegaron durante tres noches hacia la isla de cristal.",
  chap3Heading: "Capítulo 3: El regreso",
  chap3Text: "Regresaron al puerto con velas nuevas y mapas dorados.",
  listItem: "farola de aceite",
  tableCell: "abrigo",
  noteText: "Nota del archivo: la travesía duró tres noches.",
};

export function sampleEpubOptions(
  overrides: Partial<EpubBuildOptions> = {},
): EpubBuildOptions {
  const m = SAMPLE_EPUB_MARKERS;
  return {
    name: "docuviz-sample.epub",
    title: m.title,
    authors: [m.author],
    language: "es",
    version: 3,
    chapters: [
      {
        file: "chap1.xhtml",
        title: m.chap1Heading,
        body: `<h1>${m.chap1Heading}</h1>
<p>${m.chap1Text}</p>
<p>Los vecinos guardaban en el almacén los objetos necesarios para la primera parte del viaje.</p>
<ul>
  <li>${m.listItem}</li>
  <li>brújula de latón</li>
  <li>cuerda de cáñamo</li>
</ul>
<table>
  <tr><th>Objeto</th><th>Destino</th></tr>
  <tr><td>${m.tableCell}</td><td>norte</td></tr>
  <tr><td>linterna</td><td>sur</td></tr>
</table>`,
      },
      {
        file: "chap2.xhtml",
        title: m.chap2Heading,
        body: `<h1>${m.chap2Heading}</h1>
<p>${m.chap2Text}</p>
<p>El grumete leyó en voz alta las instrucciones del faro y todos asintieron.</p>
<h2>El mapa</h2>
<p>El mapa tenía tres rutas dibujadas con tinta azul.</p>`,
      },
      {
        file: "chap3.xhtml",
        title: m.chap3Heading,
        body: `<h1>${m.chap3Heading}</h1>
<p>${m.chap3Text} La tripulación preparó el equipaje para la larga travesía<a href="notes.xhtml#fn1" epub:type="noteref"><sup>[1]</sup></a>.</p>`,
      },
      {
        file: "notes.xhtml",
        title: "Notas",
        body: `<section epub:type="footnotes">
<aside id="fn1" epub:type="footnote"><p>${m.noteText}</p></aside>
</section>`,
      },
    ],
    toc: [
      { label: "Inicio", href: "chap1.xhtml" },
      {
        label: "Primera parte",
        href: "chap1.xhtml#p",
        children: [
          { label: "Capítulo 1", href: "chap1.xhtml" },
          { label: "Capítulo 2", href: "chap2.xhtml" },
        ],
      },
      { label: "Capítulo 3", href: "chap3.xhtml" },
      { label: "Nota", href: "notes.xhtml#fn1" },
    ],
    ...overrides,
  };
}

export function buildSampleEpub(
  overrides: Partial<EpubBuildOptions> = {},
): Promise<FixtureFile> {
  return buildEpub(sampleEpubOptions(overrides));
}

/* ------------------------------------------------------------------ */
/*  Threat EPUB fixtures                                               */
/* ------------------------------------------------------------------ */

export function maliciousEpub(): Promise<FixtureFile> {
  return buildEpub({
    name: "malicious.epub",
    title: "EPUB malicioso",
    authors: ["Atacante"],
    language: "es",
    version: 3,
    chapters: [
      {
        file: "chap1.xhtml",
        title: "Canal",
        head: `<link rel="stylesheet" href="https://evil.invalid/style.css"/>
<style>body { background: url("https://evil.invalid/bg.png"); }</style>`,
        body: `<h1>Canal</h1>
<p>Contenido legítimo antes del ataque.</p>
<script>window.__pwned_epub = "activo";</script>
<img src="https://evil.invalid/remote.png" alt="remoto"/>
<a href="javascript:void(window.__pwned_link=1)">enlace javascript</a>
<iframe src="https://evil.invalid/frame"></iframe>
<object data="https://evil.invalid/obj"></object>
<embed src="https://evil.invalid/emb"/>
<video src="https://evil.invalid/video.mp4"></video>
<form action="https://evil.invalid/collect"><input name="x" value="dato"/></form>
<p onclick="window.__pwned_click=1" onerror="window.__pwned_error=1">párrafo con manejadores</p>
<p>Contenido legítimo después del ataque.</p>`,
      },
      {
        file: "chap2.xhtml",
        title: "Segunda",
        body: `<h1>Segunda</h1><p>Esta sección sigue siendo legible.</p>`,
      },
    ],
    toc: [{ label: "Canal", href: "chap1.xhtml" }],
    extraEntries: {
      "OEBPS/../../pwned.txt": "escritura de prueba fuera del contenedor",
      "OEBPS/traversal/../inside.txt": "ruta normalizada dentro del libro",
    },
  });
}

export const DRM_ENCRYPTION_XML = `<?xml version="1.0" encoding="UTF-8"?>
<Encryption xmlns="http://www.w3.org/2001/04/xmlenc#">
  <EncryptedData Id="ED1" Type="http://www.w3.org/2001/04/xmlenc#Content">
    <EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/>
    <CipherData><CipherReference URI="OEBPS/chap1.xhtml"/></CipherData>
  </EncryptedData>
</Encryption>`;

/* ------------------------------------------------------------------ */
/*  DOCX builder                                                       */
/* ------------------------------------------------------------------ */

export type DocxItem =
  | { type: "heading"; level: number; text: string }
  | { type: "para"; text: string }
  | {
      type: "list";
      ordered: boolean;
      items: Array<{ text: string; children?: { ordered: boolean; items: string[] } }>;
    }
  | { type: "table"; header: string[]; rows: string[][] }
  | { type: "link"; before: string; text: string; url: string; after: string }
  | { type: "footnote"; before: string; mark: string; footnoteText: string }
  | { type: "endnote"; before: string; mark: string; endnoteText: string }
  | { type: "image"; alt: string }
  | { type: "textbox"; text: string };

export interface DocxBuildOptions {
  name?: string;
  items: DocxItem[];
  /** Extra raw OOXML appended to the body (for malformed/edge content). */
  raw?: string;
  /** Add an external TargetMode relationship of arbitrary type. */
  extraExternalRel?: { id: string; type: string; url: string };
  /** Emit [Content_Types].xml only (no document.xml) — malformed package. */
  breakDocument?: boolean;
}

let relCounter = 1;
function nextRelId(): string {
  relCounter += 1;
  return `rIdExt${relCounter}`;
}

function listXml(items: DocxItem & { type: "list" }, numId: number): string {
  const para = (text: string, ilvl: number) =>
    `<w:p><w:pPr><w:numPr><w:ilvl w:val="${ilvl}"/><w:numId w:val="${numId}"/></w:numPr></w:pPr><w:r><w:t>${xml(text)}</w:t></w:r></w:p>`;
  return items.items
    .map(
      (item) =>
        para(item.text, 0) +
        (item.children ? item.children.items.map((c) => para(c, 1)).join("") : ""),
    )
    .join("");
}

export async function buildDocx(options: DocxBuildOptions): Promise<FixtureFile> {
  relCounter = 1;
  const zip = new JSZip();
  const rels: Array<{ id: string; type: string; target: string; external?: boolean }> = [
    {
      id: "rIdNum",
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering",
      target: "numbering.xml",
    },
    {
      id: "rIdSty",
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles",
      target: "styles.xml",
    },
  ];

  const used = { footnotes: false, endnotes: false, image: false };

  const body: string[] = [];
  const fnDefs: string[] = [];
  const enDefs: string[] = [];
  let orderedNum = 0;
  let bulletNum = 0;
  let footnoteId = 1; // 0/1 reserved for separators

  for (const item of options.items) {
    switch (item.type) {
      case "heading":
        body.push(
          `<w:p><w:pPr><w:pStyle w:val="Heading${item.level}"/></w:pPr><w:r><w:t>${xml(item.text)}</w:t></w:r></w:p>`,
        );
        break;
      case "para":
        body.push(`<w:p><w:r><w:t>${xml(item.text)}</w:t></w:r></w:p>`);
        break;
      case "list": {
        if (item.ordered) orderedNum += 1;
        else bulletNum += 1;
        const numId = item.ordered ? 100 + orderedNum : 200 + bulletNum;
        body.push(listXml(item, numId));
        break;
      }
      case "table": {
        const header = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${item.header
          .map((h) => `<w:tc><w:p><w:r><w:t>${xml(h)}</w:t></w:r></w:p></w:tc>`)
          .join("")}</w:tr>`;
        const rows = item.rows
          .map(
            (r) =>
              `<w:tr>${r
                .map((c) => `<w:tc><w:p><w:r><w:t>${xml(c)}</w:t></w:r></w:p></w:tc>`)
                .join("")}</w:tr>`,
          )
          .join("");
        body.push(
          `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/>` +
            `<w:tblLook w:firstRow="1" w:lastRow="0" w:firstColumn="0" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/></w:tblPr>${header}${rows}</w:tbl>`,
        );
        break;
      }
      case "link": {
        const rid = nextRelId();
        rels.push({
          id: rid,
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink",
          target: item.url,
          external: true,
        });
        body.push(
          `<w:p><w:r><w:t>${xml(item.before)}</w:t></w:r>` +
            `<w:hyperlink r:id="${rid}"><w:r><w:rPr><w:u w:val="single"/></w:rPr><w:t>${xml(item.text)}</w:t></w:r></w:hyperlink>` +
            `<w:r><w:t>${xml(item.after)}</w:t></w:r></w:p>`,
        );
        break;
      }
      case "footnote": {
        used.footnotes = true;
        footnoteId += 1;
        fnDefs.push(
          `<w:footnote w:id="${footnoteId}"><w:p><w:r><w:t>${xml(item.footnoteText)}</w:t></w:r></w:p></w:footnote>`,
        );
        body.push(
          `<w:p><w:r><w:t>${xml(item.before)}${xml(item.mark)}</w:t></w:r>` +
            `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:footnoteReference w:id="${footnoteId}"/></w:r></w:p>`,
        );
        break;
      }
      case "endnote": {
        used.endnotes = true;
        footnoteId += 1;
        enDefs.push(
          `<w:endnote w:id="${footnoteId}"><w:p><w:r><w:t>${xml(item.endnoteText)}</w:t></w:r></w:p></w:endnote>`,
        );
        body.push(
          `<w:p><w:r><w:t>${xml(item.before)}${xml(item.mark)}</w:t></w:r>` +
            `<w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:endnoteReference w:id="${footnoteId}"/></w:r></w:p>`,
        );
        break;
      }
      case "image": {
        used.image = true;
        rels.push({
          id: "rIdImg",
          type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/image",
          target: "media/image1.png",
        });
        body.push(
          `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0">` +
            `<wp:extent cx="914400" cy="914400"/><wp:docPr id="1" name="Imagen 1" descr="${xml(item.alt)}"/>` +
            `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">` +
            `<a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
            `<pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
            `<pic:nvPicPr><pic:cNvPr id="1" name="Imagen 1" descr="${xml(item.alt)}"/><pic:cNvPicPr/></pic:nvPicPr>` +
            `<pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>` +
            `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/></a:xfrm>` +
            `<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic>` +
            `</a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`,
        );
        break;
      }
      case "textbox": {
        body.push(
          `<w:p><w:r><mc:AlternateContent><mc:Choice Requires="wps"><w:drawing>` +
            `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="914400" cy="457200"/><wp:docPr id="2" name="Cuadro 1"/>` +
            `<a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">` +
            `<wps:wsp xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"><wps:txbx>` +
            `<w:txbxContent><w:p><w:r><w:t>${xml(item.text)}</w:t></w:r></w:p></w:txbxContent>` +
            `</wps:txbx></wps:wsp></a:graphicData></a:graphic></wp:inline></w:drawing></mc:Choice>` +
            `<mc:Fallback><w:p><w:r><w:t>${xml(item.text)}</w:t></w:r></w:p></mc:Fallback>` +
            `</mc:AlternateContent></w:r></w:p>`,
        );
        break;
      }
    }
  }

  const cleanBody = body.join("\n") + (options.raw ? `\n${options.raw}` : "");

  // Numbering definitions for every numId used.
  let abstractId = 0;
  const abstractDefs: string[] = [];
  const concreteDefs: string[] = [];
  let orderedCursor = 0;
  let bulletCursor = 0;
  for (const item of options.items) {
    if (item.type !== "list") continue;
    const ordered = item.ordered;
    const numId = ordered ? 100 + ++orderedCursor : 200 + ++bulletCursor;
    abstractId += 1;
    abstractDefs.push(
      `<w:abstractNum w:abstractNumId="${abstractId}">` +
        `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${ordered ? "decimal" : "bullet"}"/>` +
        `<w:lvlText w:val="${ordered ? "%1." : "•"}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>` +
        `<w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="${ordered ? "lowerLetter" : "bullet"}"/>` +
        `<w:lvlText w:val="${ordered ? "%2)" : "–"}"/><w:lvlJc w:val="left"/>` +
        `<w:pPr><w:ind w:left="1440" w:hanging="360"/></w:pPr></w:lvl>` +
        `</w:abstractNum>`,
    );
    concreteDefs.push(
      `<w:num w:numId="${numId}"><w:abstractNumId w:val="${abstractId}"/></w:num>`,
    );
  }

  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  ${used.footnotes ? `<Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>` : ""}
  ${used.endnotes ? `<Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>` : ""}
</Types>`,
    { date: ZIP_DATE },
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`,
    { date: ZIP_DATE },
  );

  const docRels = [...rels];
  if (used.footnotes)
    docRels.push({
      id: "rIdFnt",
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes",
      target: "footnotes.xml",
    });
  if (used.endnotes)
    docRels.push({
      id: "rIdEnd",
      type: "http://schemas.openxmlformats.org/officeDocument/2006/relationships/endnotes",
      target: "endnotes.xml",
    });
  if (options.extraExternalRel) {
    docRels.push({
      id: options.extraExternalRel.id,
      type: options.extraExternalRel.type,
      target: options.extraExternalRel.url,
      external: true,
    });
  }
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${docRels
  .map(
    (r) =>
      `  <Relationship Id="${r.id}" Type="${r.type}" Target="${xml(r.target)}"${r.external ? ` TargetMode="External"` : ""}/>`,
  )
  .join("\n")}
</Relationships>`,
    { date: ZIP_DATE },
  );

  const nsDecls = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
   xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"
   xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"
   xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006"`;

  if (!options.breakDocument) {
    zip.file(
      "word/document.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${nsDecls}>
  <w:body>
${cleanBody}
    <w:sectPr/>
  </w:body>
</w:document>`,
      { date: ZIP_DATE },
    );
  }

  zip.file(
    "word/numbering.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:numbering ${nsDecls}>
${abstractDefs.join("\n")}
${concreteDefs.join("\n")}
</w:numbering>`,
    { date: ZIP_DATE },
  );

  zip.file(
    "word/styles.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles ${nsDecls}>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:qFormat/></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:qFormat/></w:style>
  <w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/></w:style>
</w:styles>`,
    { date: ZIP_DATE },
  );

  if (used.footnotes) {
    zip.file(
      "word/footnotes.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:footnotes ${nsDecls}>
  <w:footnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
${fnDefs.join("\n")}
</w:footnotes>`,
      { date: ZIP_DATE },
    );
  }
  if (used.endnotes) {
    zip.file(
      "word/endnotes.xml",
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:endnotes ${nsDecls}>
  <w:endnote w:type="separator" w:id="-1"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>
  <w:endnote w:type="continuationSeparator" w:id="0"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>
${enDefs.join("\n")}
</w:endnotes>`,
      { date: ZIP_DATE },
    );
  }
  if (used.image) {
    zip.file("word/media/image1.png", PNG_1PX, { date: ZIP_DATE });
  }

  pinEntryDates(zip);
  const buffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 6 },
  });
  return {
    name: options.name ?? "sample.docx",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    buffer,
  };
}

/* ------------------------------------------------------------------ */
/*  Canonical benign DOCX                                              */
/* ------------------------------------------------------------------ */

export const SAMPLE_DOCX_MARKERS = {
  title: "Informe semestral DocuVoz",
  h2: "Resumen ejecutivo",
  para1: "Durante el primer semestre el proyecto completó las entregas previstas.",
  listBulletHeading: "Hitos del trimestre",
  bullet1: "Reproductor con audio continuo",
  bullet2: "Exportación a MP3",
  nested: "compatible con lectores de pantalla",
  listOrderedHeading: "Pasos siguientes",
  numbered1: "Probar con diez lectores",
  numbered2: "Publicar la guía de uso",
  tableHeading: "Cifras clave",
  tableHeader1: "Indicador",
  tableHeader2: "Valor",
  tableCell1: "Documentos",
  tableCell2: "4.210",
  linkBefore: "Más detalles en el portal ",
  linkText: "informes DocuVoz",
  linkUrl: "https://example.invalid/informes",
  footnoteBefore: "La medición del alcance",
  footnoteMark: "¹",
  footnoteText: "Medición interna realizada en marzo.",
  imageAlt: "Gráfico de crecimiento trimestral",
  textboxText: "Recordatorio: revisar el anexo estadístico.",
};

export function sampleDocxItems(): DocxItem[] {
  const m = SAMPLE_DOCX_MARKERS;
  return [
    { type: "heading", level: 1, text: m.title },
    { type: "heading", level: 2, text: m.h2 },
    { type: "para", text: m.para1 },
    { type: "heading", level: 2, text: m.listBulletHeading },
    {
      type: "list",
      ordered: false,
      items: [
        { text: m.bullet1 },
        { text: m.bullet2, children: { ordered: false, items: [m.nested] } },
      ],
    },
    { type: "heading", level: 2, text: m.listOrderedHeading },
    {
      type: "list",
      ordered: true,
      items: [{ text: m.numbered1 }, { text: m.numbered2 }],
    },
    { type: "heading", level: 2, text: m.tableHeading },
    {
      type: "table",
      header: [m.tableHeader1, m.tableHeader2],
      rows: [[m.tableCell1, m.tableCell2]],
    },
    {
      type: "link",
      before: m.linkBefore,
      text: m.linkText,
      url: m.linkUrl,
      after: " (enlace externo).",
    },
    {
      type: "footnote",
      before: m.footnoteBefore,
      mark: m.footnoteMark,
      footnoteText: m.footnoteText,
    },
    { type: "image", alt: m.imageAlt },
    { type: "textbox", text: m.textboxText },
  ];
}

export function buildSampleDocx(): Promise<FixtureFile> {
  return buildDocx({ name: "docuviz-sample.docx", items: sampleDocxItems() });
}

/* ------------------------------------------------------------------ */
/*  Plain-text format fixtures                                         */
/* ------------------------------------------------------------------ */

export const SAMPLE_TXT = `\uFEFFInforme de prueba con acentos: canción, navegación, Pyrénées 1234.

Segundo párrafo después de una línea en blanco,
con un salto simple dentro del párrafo.

Tercer párrafo final.`;

export const SAMPLE_MARKDOWN = `# Informe trimestral

Texto introductorio con **negrita** y *cursiva*.

## Detalles

- primer punto de la lista
- segundo punto
  - subpunto anidado

> Una cita textual del consejo rector.

Visita la [página del proyecto](https://example.invalid/proyecto) para más información.

\`\`\`js
const x = 1;
console.log(x);
\`\`\`
`;

export const SAMPLE_HTML = `<!DOCTYPE html>
<html lang="es">
<head><meta charset="utf-8"/><title>Guía breve</title></head>
<body>
<article>
<h1>Guía breve de la biblioteca</h1>
<p>La biblioteca abre sus puertas a las ocho de la mañana.</p>
<h2>Secciones</h2>
<ul>
  <li>sala infantil</li>
  <li>sala de prensa</li>
</ul>
<p>El carné se renueva en el mostrador principal.</p>
</article>
</body>
</html>`;

export const MALICIOUS_HTML = `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="utf-8"/>
<title>Página maliciosa</title>
<link rel="stylesheet" href="https://evil.invalid/style.css"/>
<script>window.__pwned_top = "activo";</script>
</head>
<body>
<h1>Documento legítimo por fuera</h1>
<p onclick="window.__pwned_click=1" onerror="window.__pwned_error=1">
Párrafo legítimo con manejadores adjuntos.
</p>
<script src="https://evil.invalid/script.js"></script>
<img src="https://evil.invalid/pixel.gif" alt="píxel remoto"/>
<iframe src="https://evil.invalid/frame"></iframe>
<object data="https://evil.invalid/obj.swf"></object>
<embed src="https://evil.invalid/embed.swf"/>
<a href="javascript:window.__pwned_link=1">enlace javascript</a>
<video><source src="https://evil.invalid/video.mp4"/></video>
<form action="https://evil.invalid/collect"><input name="token" value="secreto"/></form>
<p>Texto final que sí debe llegar al lector.</p>
</body>
</html>`;
