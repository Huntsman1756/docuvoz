/**
 * HTML document adapter with DOMPurify sanitization.
 *
 * Parses local HTML files, sanitizes with DOMPurify to strip active
 * content, then extracts semantic blocks.
 *
 * Security: All HTML is treated as untrusted. Scripts, iframes, event
 * handlers, forms and external resources are removed by DOMPurify; the
 * remaining DOM is parsed with DOMParser (inert) and reduced to plain
 * text blocks, so remote references can never trigger a network request.
 */
import type { DocumentAdapter, LoadOptions } from "../document-adapter";
import type { StructuredDocument, DocumentBlock } from "@/domain/documents/types";

const ADAPTER_ID = "html-dom";
const ADAPTER_VERSION = "1.1.1";

/**
 * DOMPurify config for local HTML documents.
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
    "section",
    "article",
    "div",
  ],
  ALLOWED_ATTR: ["id", "href", "alt", "title", "colspan", "rowspan", "scope"],
  FORBID_TAGS: [
    "script",
    "iframe",
    "object",
    "embed",
    "form",
    "input",
    "textarea",
    "select",
    "button",
    "link",
    "meta",
    "style",
  ],
  FORBID_ATTR: [
    "onclick",
    "onerror",
    "onload",
    "onmouseover",
    "onfocus",
    "onblur",
    "onsubmit",
    "onchange",
    "style",
  ],
};

const HEADING_LEVELS: Record<string, number> = {
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  h5: 5,
  h6: 6,
};

export const htmlAdapter: DocumentAdapter = {
  id: ADAPTER_ID,
  formats: ["html"],
  mimeTypes: ["text/html", "application/xhtml+xml"],
  extensions: [".html", ".htm"],

  canOpen(file: File): boolean {
    const name = file.name.toLowerCase();
    return name.endsWith(".html") || name.endsWith(".htm") || file.type === "text/html";
  },

  async load(
    file: File,
    options: LoadOptions,
    signal?: AbortSignal,
  ): Promise<StructuredDocument> {
    const DOMPurify = (await import("dompurify")).default;

    const rawHtml = await file.text();
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

    if (rawHtml.trim().length === 0) {
      throw new Error("No se ha encontrado texto legible en este documento.");
    }

    // Sanitize: strip all active/executable content
    const cleanHtml = DOMPurify.sanitize(rawHtml, SANITIZE_CONFIG);

    // Parse sanitized HTML (DOMParser is inert: no scripts, no resource loads)
    const parser = new DOMParser();
    const doc = parser.parseFromString(cleanHtml, "text/html");

    // Remove remaining non-content elements
    removeNoiseElements(doc);

    // Extract blocks (every container is recursed — nothing is dropped)
    const contentRoot = doc.body;
    const blocks = extractBlocks(contentRoot ?? doc.body);

    if (blocks.length === 0) {
      throw new Error("No se ha encontrado texto legible en este documento.");
    }

    // Build TOC from headings
    const toc = blocks
      .filter((b) => b.type === "heading")
      .map((b) => ({
        label: b.text.replace(/[:.]+$/, "").trim(),
        depth: Math.min((b.level ?? 1) - 1, 3),
        blockIndex: b.order,
      }));

    // Detect language
    const htmlEl = doc.documentElement;
    const lang = htmlEl?.getAttribute("xml:lang") ?? htmlEl?.getAttribute("lang");
    const language = options.language ?? lang?.split("-")[0] ?? "es";

    return {
      id: options.id,
      source: {
        name: options.name ?? file.name,
        sha256: options.sha256,
        language,
      },
      blocks,
      parser: ADAPTER_ID,
      parserVersion: ADAPTER_VERSION,
      toc: toc.length > 0 ? toc : undefined,
    };
  },
};

function removeNoiseElements(doc: Document): void {
  const noiseSelectors = [
    "nav",
    "header:not(article header)",
    "footer:not(article footer)",
    ".sidebar",
    ".advertisement",
    ".cookie-banner",
    ".popup",
    "form",
    ".menu",
    ".navigation",
  ];
  for (const selector of noiseSelectors) {
    for (const el of Array.from(doc.querySelectorAll(selector))) {
      el.remove();
    }
  }
}

interface ExtractState {
  order: number;
  blocks: DocumentBlock[];
}

/** A depth-first childNodes walk owns each text node exactly once. Inline
 * nodes inherit the current owner; structural boundaries flush text in order.
 * Paragraphs inside lists/quotes/cells retain that enclosing semantic type. */
function extractBlocks(root: Element): DocumentBlock[] {
  const state: ExtractState = { order: 0, blocks: [] };
  type Owner = {
    type: DocumentBlock["type"];
    level?: number;
    listLevel?: number;
    path: string;
  };
  let text = "";
  let active: Owner = { type: "paragraph", path: "body" };
  const flush = () => {
    pushBlock(state, active.type, text.replace(/\s+/g, " "), active);
    text = "";
  };
  const visit = (node: Node, owner: Owner, path: string, depth: number) => {
    if (node.nodeType === Node.TEXT_NODE) {
      if (active !== owner) flush();
      active = owner;
      text += node.nodeValue ?? "";
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    const tag = el.tagName.toLowerCase();
    if (["script", "style", "noscript", "iframe", "object", "form"].includes(tag)) return;
    if (tag === "br") {
      text += "\n";
      return;
    }
    if (tag === "img") {
      const alt = el.getAttribute("alt")?.trim();
      if (alt) {
        if (active !== owner) flush();
        active = owner;
        text += ` [Imagen: ${alt}] `;
      }
      return;
    }
    const structural =
      /^(body|div|section|article|main|p|h[1-6]|ul|ol|li|dl|dt|dd|table|thead|tbody|tr|td|th|blockquote|pre|figure|figcaption|caption|hr)$/.test(
        tag,
      );
    let next = owner;
    if (structural) {
      flush();
      let type: DocumentBlock["type"] = owner.type;
      if (tag in HEADING_LEVELS) type = "heading";
      else if (["li", "dt", "dd"].includes(tag)) type = "list-item";
      else if (["td", "th"].includes(tag)) type = "table-cell";
      else if (tag === "blockquote") type = "quote";
      else if (tag === "pre") type = "code";
      else if (["figcaption", "caption"].includes(tag)) type = "caption";
      next = {
        type,
        path,
        level: HEADING_LEVELS[tag],
        listLevel: type === "list-item" ? Math.max(0, depth - 1) : undefined,
      };
    }
    const childDepth = depth + (tag === "ul" || tag === "ol" ? 1 : 0);
    Array.from(el.childNodes).forEach((child, i) =>
      visit(child, next, `${path}>${tag}[${i}]`, childDepth),
    );
    if (structural) flush();
  };
  visit(root, active, "body", 0);
  flush();
  return state.blocks;
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
    sourceRef: `html:${extra.path}`,
  });
  state.order++;
}
