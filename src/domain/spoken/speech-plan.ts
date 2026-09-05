import type { SpeechChunk, SpokenPlan } from "./types";

/**
 * Split a spoken plan into provider-sized chunks. Never cuts inside a
 * numeric word run when a natural boundary exists: sentence, comma, whitespace,
 * then a hard cut. Boundary whitespace is trimmed; hard cuts discard no text.
 */
export const DEFAULT_MAX_CHUNK_CHARS = 400;
/**
 * Optional lower bound. When > 0, a chunk shorter than `minChars` is folded into
 * its neighbour if that keeps it within `maxChars`. This avoids the "many tiny
 * chunks" case where the TTS prosody resets every few words and the production
 * cadence can out-run the audio — the marginal regime flagged by the harness.
 * Defaults to 0 so existing (engine/G3a) chunking is byte-for-byte unchanged.
 */
export function planChunks(
  plan: SpokenPlan,
  maxChars: number = DEFAULT_MAX_CHUNK_CHARS,
  minChars = 0,
): SpeechChunk[] {
  if (!Number.isInteger(maxChars) || maxChars < 2)
    throw new RangeError("maxChars must be an integer >= 2");
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
  if (minChars <= 1) return chunks;
  const merged: SpeechChunk[] = [];
  for (const c of chunks) {
    const prev = merged[merged.length - 1];
    const tinyNeighbour =
      prev != null && (prev.text.length < minChars || c.text.length < minChars);
    if (tinyNeighbour && prev.text.length + 1 + c.text.length <= maxChars) {
      merged[merged.length - 1] = {
        id: prev.id,
        text: `${prev.text} ${c.text}`,
        segmentIds: [...prev.segmentIds, ...c.segmentIds],
      };
    } else {
      merged.push(c);
    }
  }
  return merged.map((c, i) => ({ ...c, id: `c${i}` }));
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
    let end = cut === undefined || cut < 0 ? maxChars : cut + 1;
    // Keep surrogate pairs intact at a hard cut (UTF-16 character budget).
    if (
      end < rest.length &&
      /[\uD800-\uDBFF]/.test(rest[end - 1]) &&
      /[\uDC00-\uDFFF]/.test(rest[end])
    )
      end--;
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
