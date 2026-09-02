"use client";

import type { SpokenSegment } from "@/domain/spoken/types";

interface Props {
  documentName: string;
  segments: SpokenSegment[];
  activeIds: string[];
  selectedId: string | null;
  onSelect: (segment: SpokenSegment | null) => void;
  onPlayFrom: (segmentId: string) => void;
}

export function DocumentList({
  documentName,
  segments,
  activeIds,
  selectedId,
  onSelect,
  onPlayFrom,
}: Props) {
  const active = new Set(activeIds);
  // Pre-compute page dividers in a plain loop: React's immutability rule
  // rejects captured-variable reassignment inside render closures.
  const rows: { segment: SpokenSegment; showPage: boolean }[] = [];
  let lastPage = 0;
  for (const segment of segments) {
    const page = segment.provenance.pages[0] ?? 0;
    rows.push({ segment, showPage: page !== lastPage });
    lastPage = page;
  }
  return (
    <div className="doc-list" data-testid="doc-list" aria-label={documentName}>
      {rows.map(({ segment, showPage }) => {
        const page = segment.provenance.pages[0] ?? 0;
        const isActive = active.has(segment.id);
        const classes = [
          "segment",
          segment.muted ? "muted-noise" : "",
          isActive ? "playing" : "",
          selectedId === segment.id ? "selected" : "",
          segment.fallbackApplied ? "fallback" : "",
          segment.muted ? "" : "clickable",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <div key={segment.id} data-segment-id={segment.id}>
            {showPage && <div className="page-divider">page {page}</div>}
            <div
              className={classes}
              data-active={isActive || undefined}
              onClick={() => onSelect(segment)}
            >
              <span className="seg-text">
                {segment.muted ? segment.sourceText : segment.text || "(empty)"}
              </span>
              {segment.muted && <span className="tag">noise</span>}
              {segment.fallbackApplied && (
                <span
                  className="tag warn"
                  title="fidelity validation failed; literal text used"
                >
                  fidelity fallback
                </span>
              )}
              {!segment.muted &&
                segment.transformations.filter((t) => t.ruleId !== "pause").length >
                  0 && (
                  <span className="tag" title="normalized by deterministic rules">
                    {segment.transformations.length} rules
                  </span>
                )}
              {!segment.muted && (
                <button
                  type="button"
                  className="play-seg"
                  title="play from here"
                  aria-label="play from here"
                  onClick={(e) => {
                    e.stopPropagation();
                    onPlayFrom(segment.id);
                  }}
                >
                  ▶
                </button>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
