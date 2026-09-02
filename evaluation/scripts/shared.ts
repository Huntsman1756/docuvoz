/**
 * Shared helpers for the evaluation harness. Pure Node; no network.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DocumentBlock, StructuredDocument } from "../../src/domain/documents/types";
import {
  buildDocument,
  type RawPdfPage,
} from "../../src/adapters/document-parsers/build-document";

export const ROOT = join(__dirname, "..", "..");

export interface CorpusEntry {
  id: string;
  title: string;
  category: string;
  description: string;
  pdf: string;
  reference?: string;
  gold?: string;
  synthetic: boolean;
}

export interface CorpusManifest {
  version: number;
  notice: string;
  entries: CorpusEntry[];
}

export function loadManifest(): CorpusManifest {
  const path = join(ROOT, "public", "corpus", "manifest.json");
  return JSON.parse(readFileSync(path, "utf8")) as CorpusManifest;
}

/** Map a site-relative asset path (/corpus/...) to a filesystem path. */
export function assetPath(sitePath: string): string {
  return join(ROOT, "public", sitePath.replace(/^\//, ""));
}

export function loadReference(entry: CorpusEntry): StructuredDocument {
  if (!entry.reference) throw new Error(`fixture ${entry.id} has no reference export`);
  return JSON.parse(
    readFileSync(assetPath(entry.reference), "utf8"),
  ) as StructuredDocument;
}

export interface GoldEntry {
  blockId: string;
  spokenText: string;
}

export function loadGold(entry: CorpusEntry): GoldEntry[] | null {
  if (!entry.gold) return null;
  const file = JSON.parse(readFileSync(assetPath(entry.gold), "utf8")) as {
    entries: GoldEntry[];
  };
  return file.entries;
}

/**
 * Run the *same* browser extraction pipeline (pdf.js legacy build in Node +
 * build-document heuristics) over a fixture PDF. Mirrors
 * src/adapters/document-parsers/browser-loader.ts so G2 measures the real
 * browser path, not a Node approximation.
 */
export async function extractWithBrowserPipeline(
  pdfFile: string,
  id: string,
  name: string,
): Promise<StructuredDocument> {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const data = new Uint8Array(readFileSync(pdfFile));
  const pdf = await pdfjs.getDocument({
    data,
    standardFontDataUrl:
      join(ROOT, "node_modules", "pdfjs-dist", "standard_fonts", "") + "/",
  }).promise;
  const pages: RawPdfPage[] = [];
  try {
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      const view = page.view;
      pages.push({
        page: n,
        width: view[2] - view[0],
        height: view[3] - view[1],
        items: content.items
          .filter((item) => "str" in item && item.str.trim().length > 0)
          .map((item) => {
            const it = item as {
              str: string;
              transform: number[];
              width: number;
              height: number;
            };
            return {
              str: it.str,
              x: it.transform[4],
              yTop: view[3] - it.transform[5],
              width: it.width,
              height: it.height > 0 ? it.height : Math.abs(it.transform[3]),
            };
          }),
      });
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  return buildDocument(pages, { id, name });
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim();
}

export function wordTokens(text: string): string[] {
  return normalizeText(text).match(/[\p{L}\p{N}]+/gu) ?? [];
}

/** Sørensen–Dice coefficient over word multisets. Deterministic, 0..1. */
export function diceSimilarity(a: string, b: string): number {
  const ta = wordTokens(a);
  const tb = wordTokens(b);
  if (ta.length === 0 && tb.length === 0) return 1;
  const counts = new Map<string, number>();
  for (const t of ta) counts.set(t, (counts.get(t) ?? 0) + 1);
  let shared = 0;
  for (const t of tb) {
    const left = counts.get(t) ?? 0;
    if (left > 0) {
      shared += 1;
      counts.set(t, left - 1);
    }
  }
  return (2 * shared) / (ta.length + tb.length);
}

export const CHROME_TYPES: ReadonlySet<string> = new Set([
  "page-header",
  "page-footer",
  "page-number",
]);

export function contentBlocks(doc: StructuredDocument): DocumentBlock[] {
  return doc.blocks.filter((b) => !CHROME_TYPES.has(b.type));
}

export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

/**
 * Exact duration of a PCM WAV from its RIFF chunks (walks `fmt `/`data`
 * instead of trusting a fixed 44-byte header). Returns null for anything
 * not decodable as WAV — durations for opaque containers are never guessed.
 */
export function readWavDurationMs(bytes: Uint8Array): number | null {
  if (bytes.length < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const tag = (o: number) =>
    String.fromCharCode(bytes[o], bytes[o + 1], bytes[o + 2], bytes[o + 3]);
  if (tag(0) !== "RIFF" || tag(8) !== "WAVE") return null;
  let byteRate = 0;
  let dataSize = 0;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = tag(offset);
    const size = view.getUint32(offset + 4, true);
    if (id === "fmt " && offset + 20 <= bytes.length) {
      byteRate = view.getUint32(offset + 16, true);
    } else if (id === "data") {
      dataSize = Math.min(size, bytes.length - offset - 8);
    }
    offset += 8 + size + (size % 2);
  }
  if (byteRate > 0 && dataSize > 0) {
    return Math.round((dataSize / byteRate) * 1000);
  }
  return null;
}

export function writeResult(name: string, payload: unknown): string {
  const dir = join(ROOT, "evaluation", "results");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(payload, null, 2) + "\n");
  return path;
}
