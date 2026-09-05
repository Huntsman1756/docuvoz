/**
 * DOCX document adapter using mammoth.js + DOMPurify.
 *
 * Converts DOCX to semantic HTML via mammoth, sanitizes with DOMPurify,
 * then extracts structured blocks from the sanitized DOM.
 *
 * Security: Mammoth output is NOT sanitized by default. This adapter
 * always runs DOMPurify before any DOM interaction. External resources
 * are never loaded (`externalFileAccess: false`; images become in-memory
 * data URIs, never network references). Archive metadata is bounded by
 * zip-limits before conversion. Significant mammoth diagnostics go to the
 * laboratory diagnostics store, never into spoken content.
 */
import type { DocumentAdapter, LoadOptions } from "../document-adapter";
import type {
  StructuredDocument,
  DocumentBlock,
  TocEntry,
} from "@/domain/documents/types";
import { enforceZipLimits } from "../zip-limits";
import { recordParserDiagnostic } from "@/lib/diagnostics";

const ADAPTER_ID = "mammoth-docx";
const ADAPTER_VERSION = "1.1.0";

/** Block-level tags that carry their own canonical block. */
const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

/**
 * DOMPurify configuration: allow semantic HTML only.
 * Exported so security contract tests exercise the *real* config, not a copy.
 */
export const SANITIZE_CONFIG = {
  ALLOWED_TAGS: [
    "p",
    "b",
    "i",
    "em",
    "strong",
    "a",
    "ul",
    "ol",
    "li",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "table",
    "thead",
    "tbody",
    "tr",
    "td",
    "th",
    "blockquote",
    "pre",
    "code",
    "span",
    "br",
    "hr",
    "img",
    "figure",
    "figcaption",
    "dl",
    "dd",
    "dt",
    "sub",
    "sup",
  ],
  ALLOWED_ATTR: [
    "href",
    "src",
    "alt",
    "title",
    "id",
    "colspan",
    "rowspan",
    "scope",
    "align",
  ],
  FORBID_TAGS: ["script", "iframe", "object", "embed", "form", "input"],
  FORBID_ATTR: ["onclick", "onerror", "onload", "style"],
};

export const docxAdapter: DocumentAdapter = {
  id: ADAPTER_ID,
  formats: ["docx"],
  mimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  extensions: [".docx"],

  canOpen(file: File): boolean {
    const name = file.name.toLowerCase();
    return (
      name.endsWith(".docx") ||
      file.type ===
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    );
  },

  async load(
    file: File,
    options: LoadOptions,
    signal?: AbortSignal,
  ): Promise<StructuredDocument> {
    const JSZip = (await import("jszip")).default;
    const mammoth = await import("mammoth");
    const DOMPurify = (await import("dompurify")).default;

    const arrayBuffer = await file.arrayBuffer();
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

    // Resource-exhaustion guard on the OOXML package metadata, before Mammoth
    // decompresses anything. (Mammoth ships JSZip too — no extra parse cost
    // beyond one central-directory pass.)
    try {
      const zip = await JSZip.loadAsync(arrayBuffer);
      enforceZipLimits(zip, undefined, "DOCX");
    } catch (error) {
      if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");
      const msg = error instanceof Error ? error.message : String(error);
      if (/demasiados elementos|descomprime/.test(msg)) throw error;
      // Not a readable ZIP: let Mammoth produce its own (clearer) failure.
    }
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

    // Convert DOCX to HTML. mammoth's browser build (browser/unzip.js) reads
    // ONLY `options.arrayBuffer`; the Node build (lib/unzip.js) reads
    // `options.buffer`. Next polyfills `Buffer` on the client, so a
    // `typeof Buffer` guard mis-detects the browser and sends `{ buffer }`,
    // which browser mammoth rejects with "Could not find file in options".
    // Supply BOTH keys: each build uses the one it knows and ignores the other.
    const input: { arrayBuffer: ArrayBuffer; buffer?: Buffer } = {
      arrayBuffer,
      ...(typeof Buffer !== "undefined" ? { buffer: Buffer.from(arrayBuffer) } : {}),
    };
    const result = await mammoth.convertToHtml(input, {
      externalFileAccess: false,
    });
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

    // Surface significant conversion diagnostics in the laboratory only.
    for (const msg of result.messages) {
      if (msg.type === "warning" || msg.type === "error") {
        recordParserDiagnostic(ADAPTER_ID, msg.type, msg.message);
      }
    }

    // Sanitize HTML
    const cleanHtml = DOMPurify.sanitize(result.value, SANITIZE_CONFIG);

    // Parse sanitized HTML into DOM (inert: DOMParser never loads resources)
    const parser = new DOMParser();
    const doc = parser.parseFromString(
      `<html><body>${cleanHtml}</body></html>`,
      "text/html",
    );

    // Extract blocks from DOM
    const blocks = extractBlocks(doc);
    if (blocks.length === 0) {
      throw new Error("No se ha encontrado texto legible en este documento.");
    }

    // Build TOC from heading blocks
    const toc = buildTocFromHeadings(blocks);

    // Extract language from document content if possible
    const lang = options.language ?? detectDocLanguage(doc) ?? "es";

    return {
      id: options.id,
      source: {
        name: options.name ?? file.name,
        sha256: options.sha256,
        language: lang,
      },
      blocks,
      parser: ADAPTER_ID,
      parserVersion: ADAPTER_VERSION,
      toc: toc.length > 0 ? toc : undefined,
    };
  },
};

interface ExtractState {
  order: number;
  blocks: DocumentBlock[];
}

function extractBlocks(doc: Document): DocumentBlock[] {
  const state: ExtractState = { order: 0, blocks: [] };
  const body = doc.body;
  if (!body) return state.blocks;
  Array.from(body.children).forEach((el, i) => {
    collectFromElement(el, state, 0, `body>${el.tagName.toLowerCase()}[${i}]`);
  });
  return state.blocks;
}

/**
 * Depth-first semantic extraction. Containers (div, table rows, lists)
 * recurse so nested structure is preserved; leaf blocks emit one canonical
 * block each with a deterministic DOM path in `sourceRef`.
 */
function collectFromElement(
  el: Element,
  state: ExtractState,
  listDepth: number,
  path: string,
): void {
  const tag = el.tagName.toLowerCase();

  if (tag in HEADING_LEVELS) {
    pushBlock(state, "heading", elementText(el), {
      level: HEADING_LEVELS[tag],
      path,
    });
    return;
  }

  switch (tag) {
    case "table": {
      let col = 0;
      for (const cell of Array.from(el.querySelectorAll("th, td"))) {
        const isHeader = cell.tagName.toLowerCase() === "th";
        pushBlock(state, "table-cell", elementText(cell), {
          path: `${path}>cell[${col++}]${isHeader ? "#h" : ""}`,
        });
      }
      return;
    }
    case "ul":
    case "ol": {
      let index = 0;
      for (const child of Array.from(el.children)) {
        if (child.tagName.toLowerCase() !== "li") continue;
        collectListItem(child, state, listDepth, `${path}>li[${index++}]`);
      }
      return;
    }
    case "dl": {
      let index = 0;
      for (const child of Array.from(el.children)) {
        const childTag = child.tagName.toLowerCase();
        if (childTag !== "dt" && childTag !== "dd") continue;
        pushBlock(state, "list-item", elementText(child), {
          listLevel: listDepth,
          path: `${path}>${childTag}[${index++}]`,
        });
      }
      return;
    }
    case "blockquote": {
      pushBlock(state, "quote", elementText(el), { path });
      return;
    }
    case "pre":
    case "code": {
      pushBlock(state, "code", elementText(el), { path });
      return;
    }
    case "li": {
      collectListItem(el, state, listDepth, path);
      return;
    }
    case "figure": {
      // Emit the figure's paragraphs/captions in order; alt text of images
      // is picked up by pushBlock when a block would otherwise be empty.
      let index = 0;
      for (const child of Array.from(el.children)) {
        collectFromElement(child, state, listDepth, `${path}>${index++}`);
      }
      return;
    }
    case "figcaption":
    case "caption": {
      pushBlock(state, "caption", elementText(el), { path });
      return;
    }
    case "p": {
      pushBlock(state, "paragraph", paragraphText(el), { path });
      return;
    }
    default: {
      // Generic container: recurse children preserving document order.
      let index = 0;
      for (const child of Array.from(el.children)) {
        collectFromElement(child, state, listDepth, `${path}>${tag}[${index++}]`);
      }
      return;
    }
  }
}

/** A list item: own direct text first, then any nested lists. */
function collectListItem(
  li: Element,
  state: ExtractState,
  listDepth: number,
  path: string,
): void {
  pushBlock(state, "list-item", elementText(li, true), {
    listLevel: listDepth,
    path,
  });
  let index = 0;
  for (const child of Array.from(li.children)) {
    const childTag = child.tagName.toLowerCase();
    if (childTag === "ul" || childTag === "ol") {
      collectFromElement(child, state, listDepth + 1, `${path}>${childTag}[${index++}]`);
    } else {
      index++;
    }
  }
}

function pushBlock(
  state: ExtractState,
  type: DocumentBlock["type"],
  text: string,
  extra: { level?: number; listLevel?: number; path: string },
): void {
  const trimmed = text.trim();
  if (!trimmed) return;
  state.blocks.push({
    id: `b${state.order}`,
    type,
    text: trimmed,
    page: 1,
    order: state.order,
    level: extra.level,
    listLevel: extra.listLevel,
    sourceRef: `docx:${extra.path}`,
  });
  state.order++;
}

function elementText(el: Element, excludeNestedLists = false): string {
  const texts: string[] = [];
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (excludeNestedLists) {
        // Keep this item's own text (even wrapped in its <p>); reject text
        // that belongs to a list nested *inside* this item.
        const nearest = parent.closest("ul, ol");
        if (nearest && nearest !== el && el.contains(nearest)) {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  let node;
  while ((node = walker.nextNode())) {
    const text = node.textContent?.trim();
    if (text) texts.push(text);
  }
  if (texts.length === 0) return imageAltFallback(el);
  return texts.join(" ");
}

function paragraphText(el: Element): string {
  const text = elementText(el);
  return text || imageAltFallback(el);
}

/** Accessible description for otherwise-empty image blocks. */
function imageAltFallback(el: Element): string {
  const img = el.matches("img") ? el : el.querySelector("img[alt]");
  const alt = img?.getAttribute("alt")?.trim();
  return alt ? `[Imagen: ${alt}]` : "";
}

function buildTocFromHeadings(blocks: DocumentBlock[]): TocEntry[] {
  return blocks
    .filter((b) => b.type === "heading" && b.level != null)
    .map((b) => ({
      label: b.text.replace(/[:.]+$/, "").trim(),
      depth: Math.min((b.level ?? 1) - 1, 3),
      blockIndex: b.order,
    }));
}

function detectDocLanguage(doc: Document): string | null {
  const html = doc.documentElement;
  const lang = html?.getAttribute("xml:lang") ?? html?.getAttribute("lang");
  if (lang) return lang.split("-")[0];
  return null;
}
