/**
 * EPUB document adapter using vendored foliate-js (see vendor/foliate-js/README.md
 * for provenance: unmodified upstream parser + our JSZip-backed loader).
 *
 * Parses EPUB 2/3 via the foliate-js EPUB class, extracts metadata,
 * TOC, spine order, and readable text blocks.
 *
 * Security posture:
 *  - DRM/encrypted spine content is rejected with a clear message.
 *  - Chapters are parsed with DOMParser (inert): scripts never execute and
 *    remote resources declared by the book are never fetched.
 *  - Archive metadata is bounded by zip-limits before any inflation.
 */
import type JSZip from "jszip";
import type { DocumentAdapter, LoadOptions } from "../document-adapter";
import type {
  StructuredDocument,
  DocumentBlock,
  TocEntry,
} from "@/domain/documents/types";
import { enforceZipLimits, assessActualExpansion } from "../zip-limits";
import { recordParserDiagnostic } from "@/lib/diagnostics";

const ADAPTER_ID = "foliate-epub";
const ADAPTER_VERSION = "1.1.0";

/**
 * Algorithms that foliate-js can actually decrypt (the two stream
 * obfuscation schemes from the EPUB spec, meant for fonts only).
 * Anything else that targets a content document is real DRM.
 */
const KNOWN_OBFUSCATORS = new Set([
  "http://www.idpf.org/2008/embedding/font-obf",
  "http://ns.adobe.com/pdf/enc#RC",
]);

const CONTENT_DOC = /\.(x?html?|svg)(\?|#|$)/i;

/** Block-level elements whose text becomes one canonical block each. */
const BLOCK_SELECTOR =
  "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, figcaption, caption, dt, dd";

export const epubAdapter: DocumentAdapter = {
  id: ADAPTER_ID,
  formats: ["epub"],
  mimeTypes: ["application/epub+zip", "application/x-epub+zip"],
  extensions: [".epub"],

  canOpen(file: File): boolean {
    const name = file.name.toLowerCase();
    return name.endsWith(".epub") || file.type === "application/epub+zip";
  },

  async load(
    file: File,
    options: LoadOptions,
    signal?: AbortSignal,
  ): Promise<StructuredDocument> {
    // @ts-expect-error — vendored ES module without type declarations
    const { EPUB } = await import("../vendor/foliate-js/epub.js");
    const JSZip = (await import("jszip")).default;

    // Build foliate-js compatible loader from JSZip. Convert to ArrayBuffer
    // first (not raw File) so the same code path runs identically in browser
    // and Node test environments — JSZip's Node build does not accept Blobs.
    const buffer = await file.arrayBuffer();
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const zip = await JSZip.loadAsync(buffer);
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    enforceZipLimits(zip, undefined, "EPUB");

    await rejectProtectedContent(zip, signal);

    const loader = {
      loadText: async (name: string): Promise<string | null> => {
        const entry = zip.file(name);
        if (!entry) return null;
        const text = await entry.async("text");
        // Post-decompression accounting: verify actual inflated bytes.
        // JSZip's async() accumulates everything in memory; we reject
        // before the adapter processes the result. For text, string length
        // is a conservative lower bound on UTF-8 byte length.
        assessActualExpansion(text.length, "EPUB");
        return text;
      },
      loadBlob: async (name: string, type?: string): Promise<Blob | null> => {
        const entry = zip.file(name);
        if (!entry) return null;
        const blob = await entry.async("blob");
        // Post-decompression accounting for binary entries.
        assessActualExpansion(blob.size, "EPUB");
        return type ? new Blob([blob], { type }) : blob;
      },
      getSize: (name: string): number => {
        const entry = zip.file(name);
        // JSZip exposes uncompressed size via internal _data (central directory)
        return (
          (entry as unknown as { _data?: { uncompressedSize?: number } })?._data
            ?.uncompressedSize ?? 0
        );
      },
    };

    let book;
    try {
      book = await new EPUB(loader).init();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (/encryption|drm|decrypt/i.test(msg)) {
        throw new Error("Este EPUB está protegido y DocuVoz no puede abrirlo.");
      }
      throw new Error(`No se pudo leer el EPUB: ${msg}`);
    }
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

    try {
      return await extractFromBook(book, options, file.name, signal);
    } finally {
      book.destroy?.();
    }
  },
};

/**
 * Fail fast on documents whose readable content is encrypted with an
 * algorithm this app cannot (and must not) bypass. Font-only stream
 * obfuscation (the two idpf/adobe schemes) remains supported upstream.
 */
async function rejectProtectedContent(zip: JSZip, signal?: AbortSignal): Promise<void> {
  const entry = zip.file("META-INF/encryption.xml");
  if (!entry) return;
  const xml = await entry.async("text");
  if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
  const doc = new DOMParser().parseFromString(xml, "application/xml");
  for (const ed of Array.from(
    doc.getElementsByTagNameNS("http://www.w3.org/2001/04/xmlenc#", "EncryptedData"),
  )) {
    const algorithm = ed
      .getElementsByTagNameNS("http://www.w3.org/2001/04/xmlenc#", "EncryptionMethod")[0]
      ?.getAttribute("Algorithm");
    const uri = ed
      .getElementsByTagNameNS("http://www.w3.org/2001/04/xmlenc#", "CipherReference")[0]
      ?.getAttribute("URI");
    if (uri && CONTENT_DOC.test(uri) && !KNOWN_OBFUSCATORS.has(algorithm ?? "")) {
      throw new Error("Este EPUB está protegido con DRM y DocuVoz no puede abrirlo.");
    }
  }
}

function flattenLanguageMap(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const first = Object.values(value as Record<string, unknown>)[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

export interface EPUBBook {
  metadata?: {
    title?: string | Record<string, string>;
    author?: string | Array<{ name?: string | Record<string, string> }>;
    language?: string | string[];
    description?: string;
  };
  dir?: string;
  toc?: Array<{
    label?: string;
    href?: string;
    subitems?: unknown[];
  }>;
  sections: Array<{
    id?: string;
    linear?: string;
    cfi?: string;
    createDocument(): Promise<Document | null>;
  }>;
  destroy?(): void;
}

async function extractFromBook(
  book: EPUBBook,
  options: LoadOptions,
  filename: string,
  signal?: AbortSignal,
): Promise<StructuredDocument> {
  const meta = book.metadata ?? {};
  const title = flattenLanguageMap(meta.title);
  const author = extractAuthor(meta.author);

  const language = Array.isArray(meta.language)
    ? meta.language[0]
    : typeof meta.language === "string"
      ? meta.language
      : (options.language ?? "es");

  const dir = book.dir === "rtl" ? ("rtl" as const) : undefined;

  // Extract text from each spine section (source order = spine order).
  const blocks: DocumentBlock[] = [];
  let order = 0;
  let skippedSections = 0;
  // First block order per section path, used to resolve TOC entries.
  const firstBlockOrderByPath = new Map<string, number>();

  for (let i = 0; i < book.sections.length; i++) {
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
    const section = book.sections[i];
    if (section.linear === "no") continue;

    try {
      const doc = await section.createDocument();
      if (!doc) {
        skippedSections++;
        continue;
      }

      const paragraphs = extractParagraphsFromDOM(doc);
      if (paragraphs.length === 0) {
        skippedSections++;
        continue;
      }

      const sectionPath = typeof section.id === "string" ? section.id : `spine-${i}`;
      if (!firstBlockOrderByPath.has(sectionPath)) {
        firstBlockOrderByPath.set(sectionPath, order);
      }

      paragraphs.forEach((para, paraIndex) => {
        blocks.push({
          id: `b${order}`,
          type: "paragraph",
          text: para,
          page: i + 1, // 1-based section index
          order: order++,
          sectionIndex: i,
          sourceRef: `${sectionPath}#p${paraIndex}`,
          ...(typeof section.cfi === "string" ? { sourceCfi: section.cfi } : {}),
        });
      });
    } catch {
      // Section failed to load — skip gracefully (never abort the book).
      skippedSections++;
    }
  }

  if (skippedSections > 0) {
    recordParserDiagnostic(
      ADAPTER_ID,
      "warning",
      `${skippedSections} sección(es) del EPUB no pudieron leerse y se omitieron`,
    );
  }

  // Build TOC from book.toc with blockIndex resolved to real block order.
  const toc = buildToc(book.toc, firstBlockOrderByPath);

  // Try to extract headings from TOC and map to blocks
  const headings = extractHeadingsFromToc(book.toc, blocks);

  return {
    id: options.id,
    source: {
      name: title ?? options.name ?? filename,
      author,
      sha256: options.sha256,
      pageCount: book.sections.length,
      language,
    },
    blocks: headings.length > 0 ? mergeHeadings(blocks, headings) : blocks,
    parser: ADAPTER_ID,
    parserVersion: ADAPTER_VERSION,
    toc: toc.length > 0 ? toc : undefined,
    dir,
  };
}

function extractAuthor(raw: unknown): string | undefined {
  if (!raw) return undefined;
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    const names = raw
      .map((entry) => {
        // foliate-js `tidy()` unwraps single-key contributor objects, so an
        // entry is either a plain string or `{ name: string | LanguageMap }`.
        if (typeof entry === "string") return entry;
        return flattenLanguageMap(
          (entry as { name?: string | Record<string, string> })?.name,
        );
      })
      .filter((n): n is string => Boolean(n));
    return names.length > 0 ? names.join(", ") : undefined;
  }
  if (typeof raw === "object") {
    return flattenLanguageMap((raw as { name?: string | Record<string, string> }).name);
  }
  return undefined;
}

/**
 * Walk the (inert) parsed chapter DOM collecting text per block-level
 * element. One string per paragraph-like block; empty blocks and
 * script/style/noscript content are excluded. An element that contains
 * matching block descendants yields only its own direct text, so nested
 * structures (list inside list, p inside li…) are never spoken twice.
 */
function extractParagraphsFromDOM(doc: Document): string[] {
  const root = doc.body ?? doc.documentElement;
  const BLOCK_SELECTOR =
    "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, figcaption, caption, dt, dd";

  const paragraphs: string[] = [];
  for (const el of Array.from(root.querySelectorAll(BLOCK_SELECTOR))) {
    const ownText = elementText(el, /* directOnlyIfNested */ true);
    if (ownText) paragraphs.push(ownText);
  }
  if (paragraphs.length > 0) return paragraphs;

  // Fallback: no recognizable block elements → whole-body text as one block.
  const whole = elementText(root, false);
  return whole ? [whole] : [];
}

/**
 * Text of `el`. When `excludeNestedBlocks` is set, text belonging to
 * nested block-level descendants is omitted (it is emitted separately).
 */
function elementText(el: Element, excludeNestedBlocks: boolean): string {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const tag = parent.tagName.toLowerCase();
      if (["script", "style", "noscript"].includes(tag)) {
        return NodeFilter.FILTER_REJECT;
      }
      if (excludeNestedBlocks) {
        const nearest = parent.closest(BLOCK_SELECTOR);
        if (nearest && nearest !== el && el.contains(nearest)) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  const texts: string[] = [];
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (text && text.length > 0) texts.push(text);
  }
  return texts.join(" ").replace(/\s+/g, " ").trim();
}

/**
 * Flatten the hierarchical book TOC into an ordered, depth-annotated list —
 * the Reader renders a flat indented list, so nested entries must survive as
 * sequential items with `depth` (otherwise sub-chapters silently disappear).
 */
function buildToc(
  tocItems:
    | Array<{
        label?: string;
        href?: string;
        subitems?: unknown[];
      }>
    | null
    | undefined,
  firstBlockOrderByPath: Map<string, number>,
  depth = 0,
): TocEntry[] {
  if (!tocItems) return [];
  const out: TocEntry[] = [];
  for (const item of tocItems) {
    if (item.label && item.href) {
      out.push({
        label: item.label,
        depth,
        blockIndex: resolveTocBlockIndex(item.href, firstBlockOrderByPath),
      });
    }
    if (item.subitems) {
      out.push(
        ...buildToc(item.subitems as typeof tocItems, firstBlockOrderByPath, depth + 1),
      );
    }
  }
  return out;
}

/**
 * Map a TOC href (possibly `path#fragment` or `epubcfi(...)`) onto the order
 * of the first extracted block of the referenced section. Falls back to the
 * first block so navigation always lands somewhere sane.
 */
function resolveTocBlockIndex(
  href: string,
  firstBlockOrderByPath: Map<string, number>,
): number {
  let path = href;
  if (/^epubcfi\(/i.test(href)) return 0;
  const hash = path.indexOf("#");
  if (hash >= 0) path = path.slice(0, hash);
  let decoded = path;
  try {
    decoded = decodeURI(path);
  } catch {
    // keep raw
  }
  const flat = flattenToc(firstBlockOrderByPath);
  const exact = flat.get(decoded) ?? flat.get(path);
  return exact ?? 0;
}

function flattenToc(map: Map<string, number>): Map<string, number> {
  const out = new Map<string, number>();
  for (const [key, value] of map) out.set(key, value);
  return out;
}

function extractHeadingsFromToc(
  toc: EPUBBook["toc"],
  blocks: DocumentBlock[],
): Array<{ label: string; blockIndex: number }> {
  if (!toc) return [];
  const headings: Array<{ label: string; blockIndex: number }> = [];
  for (const item of toc) {
    if (!item.label) continue;
    // Find the block whose text starts with or contains the TOC label
    const blockIndex = blocks.findIndex((b) =>
      b.text.toLowerCase().includes(item.label!.toLowerCase().slice(0, 30)),
    );
    if (blockIndex >= 0) {
      headings.push({ label: item.label, blockIndex });
    }
    if (item.subitems) {
      headings.push(...extractHeadingsFromToc(item.subitems as EPUBBook["toc"], blocks));
    }
  }
  return headings;
}

function mergeHeadings(
  blocks: DocumentBlock[],
  headings: Array<{ label: string; blockIndex: number }>,
): DocumentBlock[] {
  const result = [...blocks];
  for (const h of headings) {
    if (h.blockIndex < result.length) {
      result[h.blockIndex] = {
        ...result[h.blockIndex],
        type: "heading",
        level: 1,
      };
    }
  }
  return result;
}
