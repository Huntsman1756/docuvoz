/**
 * Pure post-processing of raw PDF text items into a StructuredDocument.
 *
 * The pdf.js call itself lives in `browser-loader.ts` (client) so this module
 * stays testable in Node with identical inputs — the *point* of Phase 0's G2
 * gate is measuring how much structure browser extraction loses, so the
 * algorithm must be inspectable and deterministic.
 *
 * Classification heuristics (documented, deliberately simple):
 * - heading: glyph height above the modal body size
 * - footnote: glyph height well below body size, near page bottom band
 * - page-header / page-footer: top / bottom 10% bands
 * - page-number: footer consisting only of digits / "página N" / "N de M"
 * - list-item: leading bullet or enumerator
 * Tables are NOT detected in browser extraction (known limitation; measured by
 * the G2 evaluation against the reference parser).
 */
import type { DocumentBlock, StructuredDocument } from "@/domain/documents/types";

export interface RawPdfItem {
  str: string;
  /** Left edge, top-origin coordinates. */
  x: number;
  /** Baseline, top-origin coordinates. */
  yTop: number;
  width: number;
  /** Approximate glyph height. */
  height: number;
}

export interface RawPdfPage {
  /** 1-based page number. */
  page: number;
  width: number;
  height: number;
  items: RawPdfItem[];
}

export interface BuildOptions {
  id: string;
  name: string;
  sha256?: string;
  language?: string;
}

interface Line {
  items: RawPdfItem[];
  y: number;
  x: number;
  width: number;
  height: number;
  text: string;
}

const LIST_START_RE = /^(\-|[•·◦▪‣]|\(?[a-z]\)|\(?[ivxlcdm]{1,7}\)|\(?[\d]{1,3}[\).])\s/i;
const FOOTER_DIGITS_RE =
  /^\s*(?:p[aá]g(?:ina)?\.?\s*)?[\d]{1,4}(?:\s*(?:de|\/|-)\s*[\d]{1,4})?\s*$/i;

export function buildDocument(
  pages: readonly RawPdfPage[],
  options: BuildOptions,
): StructuredDocument {
  const linesPerPage = pages.map((page) => ({
    page,
    lines: groupLines(page.items),
  }));

  const blocks: DocumentBlock[] = [];
  let order = 0;
  const bodyHeight =
    mode(linesPerPage.flatMap((p) => p.lines.map((l) => l.height))) ?? 10;

  for (const { page, lines } of linesPerPage) {
    let current: Line[] = [];
    const flush = () => {
      if (current.length > 0) {
        const block = blockFromLines(current, page, order++, bodyHeight);
        if (block) blocks.push(block);
        current = [];
      }
    };
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const prev = current[current.length - 1];
      const startNew =
        !prev ||
        line.y - (prev.y + prev.height) > Math.max(prev.height * 0.6, 5) ||
        Math.abs(line.x - prev.x) > prev.height * 4 ||
        // A clearly different font size starts a new block (heading vs body).
        line.height > prev.height * 1.15 ||
        prev.height > line.height * 1.15 ||
        isListLike(line) !== (current.length > 0 && isListLike(current[0])) ||
        bandOf(line, page, bodyHeight) !== bandOf(prev, page, bodyHeight);
      if (startNew) flush();
      current.push(line);
    }
    flush();
  }

  return {
    id: options.id,
    source: {
      name: options.name,
      sha256: options.sha256,
      pageCount: pages.length,
      language: options.language ?? "es",
    },
    blocks,
    parser: "pdfjs-browser",
    parserVersion: "1.0.0",
  };
}

type Band = "header" | "body" | "footer";

/**
 * Top/bottom bands count as chrome *candidates* only for small-print lines;
 * a document title near the top of page one must stay body content.
 */
function bandOf(line: Line, page: RawPdfPage, bodyHeight: number): Band {
  const smallPrint = line.height <= bodyHeight * 0.95;
  if (!smallPrint) return "body";
  if (line.y + line.height < page.height * 0.1) return "header";
  if (line.y > page.height * 0.9) return "footer";
  return "body";
}

function groupLines(items: readonly RawPdfItem[]): Line[] {
  const sorted = [...items].filter((i) => i.str.trim().length > 0);
  sorted.sort((a, b) => a.yTop - b.yTop || a.x - b.x);
  const lines: Line[] = [];
  let group: RawPdfItem[] = [];
  let groupY = Number.NaN;

  const flush = () => {
    if (group.length === 0) return;
    group.sort((a, b) => a.x - b.x);
    let text = "";
    for (let i = 0; i < group.length; i++) {
      const item = group[i];
      if (i > 0) {
        const gap = item.x - (group[i - 1].x + group[i - 1].width);
        if (gap > group[i - 1].height * 0.45) text += " ";
      }
      text += item.str;
    }
    const heights = group.map((g) => g.height).filter((h) => h > 0);
    lines.push({
      items: group,
      y: groupY,
      x: group[0].x,
      width: Math.max(...group.map((g) => g.x + g.width)) - group[0].x,
      height: heights.length > 0 ? Math.max(...heights) : 8,
      text,
    });
    group = [];
  };

  for (const item of sorted) {
    const tolerance = Math.max(item.height * 0.5, 2);
    if (group.length === 0 || Math.abs(item.yTop - groupY) <= tolerance) {
      if (group.length === 0 || Number.isNaN(groupY)) groupY = item.yTop;
      group.push(item);
    } else {
      flush();
      groupY = item.yTop;
      group.push(item);
    }
  }
  flush();
  lines.sort((a, b) => a.y - b.y || a.x - b.x);
  return lines;
}

function blockFromLines(
  lines: readonly Line[],
  page: RawPdfPage,
  order: number,
  bodyHeight: number,
): DocumentBlock | null {
  const text = lines
    .map((l) => l.text.trim())
    .filter((t) => t.length > 0)
    .join(" ");
  if (text.length === 0) return null;
  const band = bandOf(lines[0], page, bodyHeight);
  const maxHeight = Math.max(...lines.map((l) => l.height));
  const isHeading = band === "body" && lines.length <= 2 && maxHeight > bodyHeight * 1.15;

  let type: DocumentBlock["type"];
  if (band === "header") type = "page-header";
  else if (band === "footer")
    type = FOOTER_DIGITS_RE.test(text) ? "page-number" : "page-footer";
  else if (lines.every((l) => isListLike(l))) type = "list-item";
  else if (isHeading) type = "heading";
  else if (maxHeight < bodyHeight * 0.8) type = "footnote";
  else type = "paragraph";

  const x0 = Math.min(...lines.map((l) => l.x));
  const y0 = Math.min(...lines.map((l) => l.y));
  const x1 = Math.max(...lines.map((l) => l.x + l.width));
  const y1 = Math.max(...lines.map((l) => l.y + l.height));

  return {
    id: `b${order}`,
    type,
    text,
    page: page.page,
    order,
    bbox: [round(x0), round(y0), round(x1), round(y1)],
    ...(type === "heading" ? { level: maxHeight > bodyHeight * 1.45 ? 1 : 2 } : {}),
    ...(type === "list-item" ? { listLevel: 0 } : {}),
  };
}

function isListLike(line: Line): boolean {
  return LIST_START_RE.test(line.text.trim());
}

function mode(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const counts = new Map<number, number>();
  for (const v of values) {
    const key = Math.round(v * 2) / 2;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let best = values[0];
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
