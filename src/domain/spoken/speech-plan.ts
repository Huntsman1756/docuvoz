import type { SpeechChunk, SpokenPlan } from "./types";

/**
 * Split a spoken plan into provider-sized chunks. Never cuts inside a
 * numeric word run: splits happen at sentence boundaries first, then commas,
 * then whitespace.
 */
export const DEFAULT_MAX_CHUNK_CHARS = 400;

export function planChunks(
  plan: SpokenPlan,
  maxChars: number = DEFAULT_MAX_CHUNK_CHARS,
): SpeechChunk[] {
  const chunks: SpeechChunk[] = [];
  let current = "";
  let currentSegments: string[] = [];

  const flush = () => {
    if (current.trim().length > 0) {
      chunks.push({
        id: `c${chunks.length}`,
        text: current.trim(),
        segmentIds: [...currentSegments],
      });
    }
    current = "";
    currentSegments = [];
  };

  for (const segment of plan.segments) {
    if (segment.muted || segment.text.trim().length === 0) continue;
    const pieces =
      segment.text.length > maxChars ? splitLong(segment.text, maxChars) : [segment.text];
    for (const piece of pieces) {
      if (current.length > 0 && current.length + piece.length + 1 > maxChars) {
        flush();
      }
      current = current.length > 0 ? `${current} ${piece}` : piece;
      currentSegments.push(segment.id);
    }
  }
  flush();
  return chunks;
}

function splitLong(text: string, maxChars: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > maxChars) {
    const window = rest.slice(0, maxChars);
    const cut =
      lastBoundary(window, /[.!?…]\s+\S/) ??
      lastBoundary(window, /,\s+\S/) ??
      window.lastIndexOf(" ");
    const end = cut === undefined ? maxChars : cut + 1;
    out.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trimStart();
  }
  if (rest.length > 0) out.push(rest);
  return out.filter((p) => p.length > 0);
}

function lastBoundary(window: string, pattern: RegExp): number | undefined {
  let found: number | undefined;
  const re = new RegExp(
    pattern.source,
    pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`,
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(window)) !== null) {
    found = m.index + 1;
  }
  return found;
}
