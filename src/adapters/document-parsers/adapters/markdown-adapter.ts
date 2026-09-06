/**
 * Markdown document adapter using markdown-it.
 *
 * Parses Markdown via markdown-it into tokens, then extracts semantic
 * blocks. Syntax characters are not included in spoken text — only the
 * semantic content is preserved. Line provenance comes from markdown-it's
 * own token.map (source line ranges).
 */
import type { DocumentAdapter, LoadOptions } from "../document-adapter";
import type { StructuredDocument, DocumentBlock } from "@/domain/documents/types";

const ADAPTER_ID = "markdown-it";
const ADAPTER_VERSION = "1.1.0";

export const markdownAdapter: DocumentAdapter = {
  id: ADAPTER_ID,
  formats: ["markdown"],
  mimeTypes: ["text/markdown", "text/x-markdown"],
  extensions: [".md", ".markdown", ".mdown", ".mkd"],

  canOpen(file: File): boolean {
    const name = file.name.toLowerCase();
    return (
      name.endsWith(".md") ||
      name.endsWith(".markdown") ||
      name.endsWith(".mdown") ||
      name.endsWith(".mkd") ||
      file.type === "text/markdown"
    );
  },

  async load(
    file: File,
    options: LoadOptions,
    signal?: AbortSignal,
  ): Promise<StructuredDocument> {
    const markdownit = (await import("markdown-it")).default;

    const text = await file.text();
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

    if (text.trim().length === 0) {
      throw new Error("No se ha encontrado texto legible en este documento.");
    }

    const md = markdownit({ html: false, linkify: true, typographer: true });
    const tokens = md.parse(text, {});

    const blocks = tokensToBlocks(tokens);
    if (blocks.length === 0 || blocks.every((b) => b.text.trim().length === 0)) {
      throw new Error("No se ha encontrado texto legible en este documento.");
    }

    const toc = blocks
      .filter((b) => b.type === "heading")
      .map((b) => ({
        label: b.text.replace(/[:.]+$/, "").trim(),
        depth: Math.min((b.level ?? 1) - 1, 3),
        blockIndex: b.order,
      }));

    return {
      id: options.id,
      source: {
        name: options.name ?? file.name,
        sha256: options.sha256,
        language: options.language ?? "es",
      },
      blocks,
      parser: ADAPTER_ID,
      parserVersion: ADAPTER_VERSION,
      toc: toc.length > 0 ? toc : undefined,
    };
  },
};

interface MarkdownToken {
  type: string;
  tag: string;
  content: string;
  children?: MarkdownToken[] | null;
  nesting?: number;
  map?: [number, number] | null;
}

function lineRef(token: MarkdownToken): string | undefined {
  if (!token.map) return undefined;
  return `L${token.map[0] + 1}-L${token.map[1]}`;
}

/**
 * Gather spoken text from inline tokens. Walks into emphasis/link/etc.
 * children so link TEXT survives; syntax characters never enter the text.
 */
function inlineText(children: MarkdownToken[] | null | undefined): string {
  if (!children) return "";
  const parts: string[] = [];
  for (const c of children) {
    switch (c.type) {
      case "text":
      case "code_inline":
        parts.push(c.content);
        break;
      case "softbreak":
        parts.push(" ");
        break;
      case "hardbreak":
        parts.push("\n");
        break;
      case "image":
        if (c.content.trim()) parts.push(`[Imagen: ${c.content.trim()}]`);
        break;
      case "link_open":
      case "link_close":
        if (c.children) parts.push(inlineText(c.children));
        break;
      default:
        if (c.children) parts.push(inlineText(c.children));
        else if (c.content) parts.push(c.content);
    }
  }
  return parts.join("");
}

interface BlockState {
  order: number;
  blocks: DocumentBlock[];
}

type PushFn = (
  type: DocumentBlock["type"],
  text: string,
  token: MarkdownToken,
  extra?: { level?: number; listLevel?: number },
) => void;

function tokensToBlocks(tokens: MarkdownToken[]): DocumentBlock[] {
  const state: BlockState = { order: 0, blocks: [] };
  const push: PushFn = (type, text, token, extra) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    state.blocks.push({
      id: `b${state.order}`,
      type,
      text: trimmed,
      page: 1,
      order: state.order,
      level: extra?.level,
      listLevel: extra?.listLevel,
      sourceRef: lineRef(token),
    });
    state.order++;
  };

  let i = 0;
  while (i < tokens.length) {
    const token = tokens[i];

    if (token.type === "heading_open") {
      const level = parseInt(token.tag.slice(1), 10);
      push("heading", inlineText(tokens[i + 1]?.children), token, { level });
      i += 3; // heading_open, inline, heading_close
    } else if (token.type === "paragraph_open") {
      push("paragraph", inlineText(tokens[i + 1]?.children), token);
      i += 3; // paragraph_open, inline, paragraph_close
    } else if (token.type === "fence" || token.type === "code_block") {
      push("code", token.content, token);
      i++;
    } else if (token.type === "blockquote_open") {
      push("quote", collectInlineText(tokens, i), token);
      let depth = 1;
      i++;
      while (i < tokens.length && depth > 0) {
        if (tokens[i].type === "blockquote_open") depth++;
        if (tokens[i].type === "blockquote_close") depth--;
        i++;
      }
    } else if (token.type === "bullet_list_open" || token.type === "ordered_list_open") {
      const closeType =
        token.type === "bullet_list_open" ? "bullet_list_close" : "ordered_list_close";
      const end = matchingClose(tokens, i, token.type, closeType, tokens.length);
      walkList(tokens, i + 1, end, 0, state, push);
      i = end + 1;
    } else if (token.type === "table_open") {
      push("paragraph", collectTableText(tokens, i), token);
      while (i < tokens.length && tokens[i].type !== "table_close") i++;
      i++;
    } else if (token.type === "hr") {
      state.blocks.push({
        id: `b${state.order}`,
        type: "separator",
        text: "",
        page: 1,
        order: state.order,
      });
      state.order++;
      i++;
    } else {
      i++;
    }
  }

  return state.blocks;
}

/** Index of the token closing the block opened at `start` (depth-tracked). */
function matchingClose(
  tokens: MarkdownToken[],
  start: number,
  openType: string,
  closeType: string,
  limit: number,
): number {
  let depth = 0;
  for (let i = start; i < limit; i++) {
    if (tokens[i].type === openType) depth++;
    else if (tokens[i].type === closeType) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return limit;
}

/**
 * Walk a list range emitting one block per item at its nesting level.
 * An item's own paragraphs contribute to its block; nested sublists are
 * walked separately at level+1 — items are never merged into their parent.
 */
function walkList(
  tokens: MarkdownToken[],
  start: number,
  end: number,
  level: number,
  state: BlockState,
  push: PushFn,
): void {
  void state;
  let j = start;
  while (j < end) {
    const t = tokens[j];
    if (t.type !== "list_item_open") {
      j++;
      continue;
    }
    const itemEnd = matchingClose(tokens, j, "list_item_open", "list_item_close", end);
    const ownParts: string[] = [];
    const nested: Array<[number, number]> = [];
    let k = j + 1;
    while (k < itemEnd) {
      const u = tokens[k];
      if (u.type === "bullet_list_open" || u.type === "ordered_list_open") {
        const closeType =
          u.type === "bullet_list_open" ? "bullet_list_close" : "ordered_list_close";
        const uEnd = matchingClose(tokens, k, u.type, closeType, itemEnd);
        nested.push([k, uEnd]);
        k = uEnd + 1;
        continue;
      }
      if (u.type === "inline" && u.children) ownParts.push(inlineText(u.children));
      k++;
    }
    push("list-item", ownParts.join(" "), t, { listLevel: level });
    for (const [ns, ne] of nested) walkList(tokens, ns + 1, ne, level + 1, state, push);
    j = itemEnd + 1;
  }
}

function collectInlineText(tokens: MarkdownToken[], startIndex: number): string {
  const texts: string[] = [];
  let i = startIndex + 1;
  let depth = 1;

  while (i < tokens.length && depth > 0) {
    const t = tokens[i];
    if (t.nesting === 1) depth++;
    if (t.nesting === -1) depth--;
    if (depth === 0) break;

    if (t.children) {
      for (const child of t.children) {
        if (child.type === "text" || child.type === "code_inline") {
          texts.push(child.content);
        } else if (child.type === "softbreak") {
          texts.push(" ");
        }
      }
    } else if (t.content) {
      texts.push(t.content);
    }
    i++;
  }

  return texts.join(" ");
}

function collectTableText(tokens: MarkdownToken[], startIndex: number): string {
  const texts: string[] = [];
  let i = startIndex;

  while (i < tokens.length && tokens[i].type !== "table_close") {
    const t = tokens[i];
    if (t.children) {
      for (const child of t.children) {
        if (child.type === "text") {
          texts.push(child.content);
        }
      }
    }
    i++;
  }

  return texts.join(" ");
}
