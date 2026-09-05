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
const ADAPTER_VERSION = "1.1.0";

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

/** Nested block-level elements: outer containers must not duplicate them. */
const BLOCK_SELECTOR =
  "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, td, th, figcaption, caption, dt, dd";

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
    const contentRoot = doc.querySelector("article, main, [role='main']") ?? doc.body;
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

function extractBlocks(root: Element): DocumentBlock[] {
  const state: ExtractState = { order: 0, blocks: [] };
  let index = 0;
  for (const el of Array.from(root.children)) {
    collectFromElement(el, state, 0, `${root.tagName.toLowerCase()}>${index++}`);
  }
  // Fallback: leaf documents (e.g. <body>Text only</body>)
  if (state.blocks.length === 0) {
    const text = elementText(root, true);
    if (text) {
      state.blocks.push({
        id: "b0",
        type: "paragraph",
        text,
        page: 1,
        order: 0,
        sourceRef: "html:fallback",
      });
    }
  }
  return state.blocks;
}

function collectFromElement(
  el: Element,
  state: ExtractState,
  listDepth: number,
  path: string,
): void {
  const tag = el.tagName.toLowerCase();

  if (tag in HEADING_LEVELS) {
    pushBlock(state, "heading", elementText(el, true), {
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
        pushBlock(state, "table-cell", elementText(cell, true), {
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
        pushBlock(state, "list-item", elementText(child, true), {
          listLevel: listDepth,
          path: `${path}>${childTag}[${index++}]`,
        });
      }
      return;
    }
    case "blockquote": {
      pushBlock(state, "quote", elementText(el, true), { path });
      return;
    }
    case "pre":
    case "code": {
      pushBlock(state, "code", elementText(el, true), { path });
      return;
    }
    case "li": {
      collectListItem(el, state, listDepth, path);
      return;
    }
    case "figcaption":
    case "caption": {
      pushBlock(state, "caption", elementText(el, true), { path });
      return;
    }
    case "p": {
      pushBlock(state, "paragraph", paragraphText(el), { path });
      return;
    }
    default: {
      // Generic container (div/section/article/span…): recurse in order.
      let index = 0;
      for (const child of Array.from(el.children)) {
        collectFromElement(child, state, listDepth, `${path}>${tag}[${index++}]`);
      }
      // Leaf containers with only text (rare post-sanitize) are handled by
      // the block-level branches above; nothing to emit here.
      return;
    }
  }
}

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
  for (const child of Array.from(li.children)) {
    const childTag = child.tagName.toLowerCase();
    if (childTag === "ul" || childTag === "ol") {
      collectFromElement(child, state, listDepth + 1, `${path}>${childTag}`);
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
    sourceRef: `html:${extra.path}`,
  });
  state.order++;
}

/**
 * Text of `el`; when `excludeNestedBlocks` is set, text owned by nested
 * block-level descendants is skipped (it is emitted as its own block).
 */
function elementText(el: Element, excludeNestedBlocks: boolean): string {
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      const t = parent.tagName.toLowerCase();
      if (["script", "style", "noscript"].includes(t)) {
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
    if (text) texts.push(text);
  }
  if (texts.length === 0) return imageAltFallback(el);
  return texts.join(" ");
}

function paragraphText(el: Element): string {
  return elementText(el, true) || imageAltFallback(el);
}

function imageAltFallback(el: Element): string {
  const img = el.matches("img") ? el : el.querySelector("img[alt]");
  const alt = img?.getAttribute("alt")?.trim();
  return alt ? `[Imagen: ${alt}]` : "";
}
