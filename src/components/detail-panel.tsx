"use client";

import type { StructuredDocument } from "@/domain/documents/types";
import type { SpokenSegment } from "@/domain/spoken/types";
import type { HealthDescriptor } from "@/lib/speech-player";
import type { PlayerMetrics } from "@/lib/speech-player";

interface Props {
  segment: SpokenSegment | null;
  document: StructuredDocument | null;
  metrics: PlayerMetrics | null;
  chunkCount: number;
  health:
    | (HealthDescriptor & {
        ok: boolean;
        maxTextChars?: number;
        spokenEngineVersion?: string;
      })
    | null;
  docSource: "pdf" | "reference";
}

const fmt = (values: number[], percentile = 0.5): string => {
  if (values.length === 0) return "—";
  const sorted = [...values].sort((a, b) => a - b);
  const at = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * percentile))];
  return `${Math.round(at)} ms`;
};

export function DetailPanel({
  segment,
  document,
  metrics,
  chunkCount,
  health,
  docSource,
}: Props) {
  return (
    <aside className="detail">
      <h2>Inspector</h2>
      {segment ? (
        <div className="detail-body">
          <h3>Source (literal)</h3>
          <p className="mono block-text">{segment.sourceText}</p>
          <h3>Spoken</h3>
          <p className="mono block-text spoken">
            {segment.muted ? "(muted: layout noise)" : segment.text || "(empty)"}
          </p>
          {segment.fallbackApplied && (
            <p className="warn-box">
              Transformations were rejected by the fidelity validator; the literal text is
              spoken instead.
            </p>
          )}
          <h3>Transformations ({segment.transformations.length})</h3>
          <ul className="transformations">
            {segment.transformations.map((t, i) => (
              <li key={`${t.ruleId}-${i}`}>
                <code>{t.ruleId}</code>: “{t.source}” → “{t.replacement}”
              </li>
            ))}
          </ul>
          <h3>Provenance</h3>
          <table className="kv">
            <tbody>
              <tr>
                <td>document</td>
                <td>{segment.provenance.documentId}</td>
              </tr>
              <tr>
                <td>blocks</td>
                <td>{segment.provenance.blockIds.join(", ")}</td>
              </tr>
              <tr>
                <td>pages</td>
                <td>{segment.provenance.pages.join(", ")}</td>
              </tr>
              {segment.provenance.bbox && (
                <tr>
                  <td>bbox</td>
                  <td>{segment.provenance.bbox.map((n) => Math.round(n)).join(", ")}</td>
                </tr>
              )}
              {document?.source.sha256 && (
                <tr>
                  <td>sha256</td>
                  <td>{document.source.sha256.slice(0, 16)}…</td>
                </tr>
              )}
              <tr>
                <td>extraction</td>
                <td>
                  {document?.parser}
                  {docSource === "reference" ? " (reference export)" : " (browser)"}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <p className="hint">
          Click a segment to compare source vs spoken text and inspect provenance.
        </p>
      )}

      <h2>Metrics</h2>
      <table className="kv metrics">
        <tbody>
          <tr>
            <td>chunks</td>
            <td>{chunkCount}</td>
          </tr>
          <tr>
            <td>requests</td>
            <td>{metrics?.requests ?? 0}</td>
          </tr>
          <tr>
            <td>request latency p50 / p95</td>
            <td>
              {fmt(metrics?.requestLatenciesMs ?? [], 0.5)} /{" "}
              {fmt(metrics?.requestLatenciesMs ?? [], 0.95)}
            </td>
          </tr>
          <tr>
            <td>local cache hits</td>
            <td>{metrics?.localCacheHits ?? 0}</td>
          </tr>
          <tr>
            <td>server cache hits</td>
            <td>{metrics?.serverCacheHits ?? 0}</td>
          </tr>
          <tr>
            <td>queue underruns</td>
            <td>{metrics?.underruns ?? 0}</td>
          </tr>
          <tr>
            <td>provider errors</td>
            <td>{metrics?.errors ?? 0}</td>
          </tr>
          <tr>
            <td>provider</td>
            <td>
              {health ? `${health.provider} / ${health.model} / ${health.voice}` : "—"}
              {health?.provider === "nan" ? " (validation infra)" : ""}
            </td>
          </tr>
        </tbody>
      </table>
      <p className="hint">
        Phase 0 measures latency instead of assuming it. Keep the numbers in
        <code>evaluation/results/</code> honest by re-running the eval scripts.
      </p>
    </aside>
  );
}
