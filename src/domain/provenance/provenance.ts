/**
 * Span-level provenance: every spoken segment can be traced back to the
 * exact blocks (and page/bbox when available) it was generated from.
 *
 * TRACEABLE (provenance exists), PRESERVED (critical values survive) and
 * SEMANTICALLY FAITHFUL (meaning survives) are distinct properties. Only the
 * first two are machine-verified here; the third requires human evaluation.
 */

export interface SegmentProvenance {
  documentId: string;
  /** Source block ids in reading order; never empty. */
  blockIds: string[];
  /** 1-based page numbers involved. */
  pages: number[];
  /** Union bounding box where available. */
  bbox?: readonly [number, number, number, number];
  /** Character range within the concatenated source block text. */
  sourceStart?: number;
  sourceEnd?: number;
}

export function mergeProvenance(
  documentId: string,
  blocks: readonly {
    id: string;
    page: number;
    bbox?: readonly [number, number, number, number];
    text: string;
  }[],
): SegmentProvenance {
  const pages = [...new Set(blocks.map((b) => b.page))].sort((a, b) => a - b);
  const boxes = blocks.filter((b) => b.bbox).map((b) => b.bbox as BBoxLike);
  let bbox: SegmentProvenance["bbox"];
  if (boxes.length > 0) {
    bbox = [
      Math.min(...boxes.map((b) => b[0])),
      Math.min(...boxes.map((b) => b[1])),
      Math.max(...boxes.map((b) => b[2])),
      Math.max(...boxes.map((b) => b[3])),
    ];
  }
  return {
    documentId,
    blockIds: blocks.map((b) => b.id),
    pages,
    bbox,
    sourceStart: 0,
    sourceEnd: blocks.reduce((acc, b) => acc + b.text.length, 0),
  };
}

type BBoxLike = readonly [number, number, number, number];
