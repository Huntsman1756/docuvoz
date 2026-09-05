"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StructuredDocument } from "@/domain/documents/types";
import type { GoldEntry, SpokenPlan, SpokenSegment } from "@/domain/spoken/types";
import { buildGoldPlan, buildSpokenPlan } from "@/domain/spoken/pipeline";
import { planChunks } from "@/domain/spoken/speech-plan";
import {
  resolveAdapter,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_FORMATS_LABEL,
} from "@/adapters/document-parsers/adapter-registry";
import { validateDocumentFile } from "@/lib/ingest";
import {
  getParserDiagnostics,
  clearParserDiagnostics,
  type ParserDiagnostic,
} from "@/lib/diagnostics";
import {
  SpeechPlayer,
  type HealthDescriptor,
  type PlayerMetrics,
  type PlayerState,
} from "@/lib/speech-player";
import { loadGold, loadManifest, loadReference, type CorpusManifest } from "@/lib/corpus";
import { DocumentList } from "./document-list";
import { DetailPanel } from "./detail-panel";
import { PlayerBar } from "./player-bar";

export type Mode = "literal" | "listen" | "gold";
type Phase = "empty" | "extracting" | "ready" | "error";

export function Lab() {
  const [corpus, setCorpus] = useState<CorpusManifest | null>(null);
  const [health, setHealth] = useState<
    | (HealthDescriptor & {
        ok: boolean;
        spokenEngineVersion?: string;
        maxTextChars?: number;
      })
    | null
  >(null);
  const [doc, setDoc] = useState<StructuredDocument | null>(null);
  const [docSource, setDocSource] = useState<"pdf" | "reference">("pdf");
  const [goldEntries, setGoldEntries] = useState<GoldEntry[] | null>(null);
  const [fixtureId, setFixtureId] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("listen");
  const [phase, setPhase] = useState<Phase>("empty");
  const [statusText, setStatusText] = useState("");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [selected, setSelected] = useState<SpokenSegment | null>(null);
  const [playerState, setPlayerState] = useState<PlayerState>("idle");
  const [metrics, setMetrics] = useState<PlayerMetrics | null>(null);
  const [chunkIndex, setChunkIndex] = useState(0);
  const [rate, setRate] = useState(1);
  const [diagnostics, setDiagnostics] = useState<ParserDiagnostic[]>([]);
  const playerRef = useRef<SpeechPlayer | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const refreshDiagnostics = useCallback(
    () => setDiagnostics(getParserDiagnostics()),
    [],
  );

  useEffect(() => {
    void loadManifest()
      .then(setCorpus)
      .catch(() => setCorpus(null));
    fetch("/api/health")
      .then((r) => r.json() as Promise<HealthDescriptor & { ok: boolean }>)
      .then((h) => {
        setHealth(h);
        // Pick up diagnostics persisted by a previous parse in this session.
        refreshDiagnostics();
      })
      .catch(() => setHealth(null));
  }, [refreshDiagnostics]);

  const plan: SpokenPlan | null = useMemo(() => {
    if (!doc) return null;
    if (mode === "gold" && goldEntries) return buildGoldPlan(doc, goldEntries);
    return buildSpokenPlan(doc, mode === "listen" ? "listen" : "literal");
  }, [doc, mode, goldEntries]);

  const chunks = useMemo(() => (plan ? planChunks(plan) : []), [plan]);

  // The highlight is *derived* from player state + chunk index. Keeping it in
  // separate state forced a synchronous reset inside the effect below, which
  // React flags as a cascading-render anti-pattern.
  const activeIds = useMemo(
    () => (playerState === "idle" ? [] : (chunks[chunkIndex]?.segmentIds ?? [])),
    [playerState, chunkIndex, chunks],
  );

  useEffect(() => {
    playerRef.current?.destroy();
    if (chunks.length === 0) {
      playerRef.current = null;
      return;
    }
    const player = new SpeechPlayer(chunks, {
      onStateChange: setPlayerState,
      onChunkChange: setChunkIndex,
      onMetrics: setMetrics,
      onError: (code) => setErrorText(`speech error: ${code}`),
    });
    playerRef.current = player;
    return () => player.destroy();
  }, [chunks]);

  const analyzeFile = useCallback(
    async (file: File) => {
      setPhase("extracting");
      setErrorText(null);
      setStatusText("extracting text client-side…");
      try {
        const resolved = await resolveAdapter(file);
        if (!resolved) {
          setPhase("error");
          setErrorText(
            `Formato no soportado: "${file.name}". Formatos aceptados: ${SUPPORTED_FORMATS_LABEL}.`,
          );
          return;
        }
        const { adapter } = resolved;
        const extracted = await adapter.load(file, {
          id: `doc-${file.name}-${Date.now()}`,
          name: file.name,
        });
        setDoc(extracted);
        setDocSource("pdf");
        setGoldEntries(null);
        setFixtureId(null);
        setMode("listen");
        setPhase("ready");
        setSelected(null);
        setStatusText(
          `${extracted.blocks.length} blocks on ${extracted.source.pageCount ?? extracted.blocks.length} sections`,
        );
      } catch (error) {
        setPhase("error");
        const msg = error instanceof Error ? error.message : "unknown";
        setErrorText(`No se pudo leer el documento: ${msg}`);
      } finally {
        refreshDiagnostics();
      }
    },
    [refreshDiagnostics],
  );

  const onFile = useCallback(
    async (file: File) => {
      const invalid = validateDocumentFile(file);
      if (invalid) {
        setPhase("error");
        setErrorText(
          invalid === "file_too_large"
            ? "rejected: file_too_large"
            : invalid === "empty_file"
              ? "rejected: empty_file"
              : `Formato no soportado: ${SUPPORTED_FORMATS_LABEL}`,
        );
        return;
      }
      await analyzeFile(file);
    },
    [analyzeFile],
  );

  const loadFixture = useCallback(
    async (id: string, useReference: boolean) => {
      const entry = corpus?.entries.find((e) => e.id === id);
      if (!entry) return;
      setPhase("extracting");
      setErrorText(null);
      try {
        if (useReference && entry.reference) {
          const gold = entry.gold ? await loadGold(entry.gold).catch(() => null) : null;
          setStatusText("loading reference (desktop-parser-shaped) extraction…");
          const ref = await loadReference(entry.reference);
          setDoc(ref);
          setDocSource("reference");
          setGoldEntries(gold);
          setFixtureId(entry.id);
          setMode(gold && gold.length > 0 ? "gold" : "listen");
          setPhase("ready");
          setSelected(null);
          setStatusText(
            `reference extraction: ${ref.blocks.length} blocks on ${ref.source.pageCount ?? "?"} pages`,
          );
          return;
        }
        if (useReference) {
          throw new Error("this fixture has no reference extraction");
        }
        setStatusText(`fetching fixture ${entry.pdf}…`);
        const res = await fetch(entry.pdf);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const ext = entry.pdf.match(/\.[^.]+$/)?.[0] ?? ".pdf";
        const file = new File([blob], `${entry.id}${ext}`, { type: blob.type });
        await analyzeFile(file);
        setFixtureId(entry.id);
      } catch (error) {
        setPhase("error");
        setErrorText(
          `fixture load failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
    },
    [corpus, analyzeFile],
  );

  const playPause = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (playerState === "playing") player.pause();
    else if (playerState === "paused") player.resume();
    else void player.play(0);
  }, [playerState]);

  const playFromSegment = useCallback(
    (segmentId: string) => {
      const index = chunks.findIndex((c) => c.segmentIds.includes(segmentId));
      if (index >= 0) void playerRef.current?.seekToChunk(index);
    },
    [chunks],
  );

  const changeRate = useCallback((value: number) => {
    setRate(value);
    playerRef.current?.setPlaybackRate(value);
  }, []);

  const goldAvailable = goldEntries !== null && goldEntries.length > 0;

  return (
    <main className="lab">
      <header className="lab-header">
        <div>
          <h1>AUIDIO NAN — document → audio reading laboratory</h1>
          <p className="sub">
            Phase 0 · Spanish regulatory documents · Literal vs deterministic Listen vs
            Manual Gold
          </p>
        </div>
        <div className="provider">
          <Link href="/" className="chip">
            ← Lector
          </Link>
          {health ? (
            <span className={health.provider === "nan" ? "badge badge-warn" : "badge"}>
              provider: {health.provider} ({health.model})
              {health.provider === "nan" ? " · validation infra" : ""}
            </span>
          ) : (
            <span className="badge badge-err">server unavailable</span>
          )}
        </div>
      </header>

      <section className="panel">
        <div
          className="dropzone"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const file = e.dataTransfer.files?.[0];
            if (file) void onFile(file);
          }}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept={SUPPORTED_EXTENSIONS}
            hidden
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void onFile(file);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            className="primary"
            onClick={() => fileInputRef.current?.click()}
          >
            Select document
          </button>
          <span className="hint">
            {SUPPORTED_FORMATS_LABEL} · parsed 100% in your browser · max 50 MB
          </span>
        </div>
        {corpus && corpus.entries.length > 0 && (
          <div className="corpus">
            <span className="corpus-label">corpus:</span>
            {corpus.entries.map((entry) => (
              <span key={entry.id} className="chip-group" title={entry.description}>
                <button
                  type="button"
                  className={
                    fixtureId === entry.id && docSource === "pdf" ? "chip active" : "chip"
                  }
                  onClick={() => void loadFixture(entry.id, false)}
                >
                  {entry.title}
                </button>
                {entry.reference && (
                  <button
                    type="button"
                    className={
                      fixtureId === entry.id && docSource === "reference"
                        ? "chip ref active"
                        : "chip ref"
                    }
                    title="reference (desktop-grade) extraction + manual gold"
                    onClick={() => void loadFixture(entry.id, true)}
                  >
                    ref{entry.gold ? " ★" : ""}
                  </button>
                )}
              </span>
            ))}
          </div>
        )}
      </section>

      {phase === "extracting" && (
        <div className="status">⏳ {statusText || "working…"}</div>
      )}
      {errorText && (
        <div className="status error" role="alert">
          ✖ {errorText}
        </div>
      )}

      {diagnostics.length > 0 && (
        <section
          className="panel"
          data-testid="parser-diagnostics"
          aria-label="diagnósticos del parser"
        >
          <div className="status">
            🧾 parser diagnostics ({diagnostics.length})
            <button
              type="button"
              className="chip"
              style={{ marginLeft: 8 }}
              onClick={() => {
                clearParserDiagnostics();
                refreshDiagnostics();
              }}
            >
              clear
            </button>
          </div>
          <ul style={{ margin: "4px 0 0", paddingLeft: 20, fontSize: "0.85rem" }}>
            {diagnostics.slice(-20).map((d, i) => (
              <li key={i} data-diag-level={d.level}>
                <code>{d.source}</code> · {d.level} · {d.message}
              </li>
            ))}
          </ul>
        </section>
      )}

      {plan && doc && (
        <>
          <section className="controls">
            <div className="modes" role="radiogroup" aria-label="Spoken mode">
              <button
                type="button"
                className={mode === "literal" ? "mode active" : "mode"}
                onClick={() => setMode("literal")}
              >
                Literal
              </button>
              <button
                type="button"
                className={mode === "listen" ? "mode active" : "mode"}
                onClick={() => setMode("listen")}
              >
                Listen
              </button>
              <button
                type="button"
                className={mode === "gold" ? "mode active" : "mode"}
                disabled={!goldAvailable}
                title={
                  goldAvailable
                    ? "Manual Gold: human-authored upper bound (experiment only)"
                    : "Available for corpus fixtures with gold files"
                }
                onClick={() => goldAvailable && setMode("gold")}
              >
                Manual Gold
              </button>
            </div>
            <div className="stats">
              <span title="blocks">{plan.stats.blocksTotal} blocks</span>
              <span title="spoken segments">{plan.stats.segments} segments</span>
              {mode !== "literal" && (
                <>
                  <span title="segments modified by rules">
                    {plan.stats.transformed} transformed
                  </span>
                  <span title="segments muted as page chrome">
                    {plan.stats.mutedNoise} muted
                  </span>
                  <span
                    className={plan.stats.rejected > 0 ? "stat-warn" : ""}
                    title="fidelity validation rejected transformations"
                  >
                    {plan.stats.rejected} fallbacks
                  </span>
                </>
              )}
              <span className="muted">engine {plan.spokenEngineVersion}</span>
            </div>
          </section>

          <div className="workspace">
            <DocumentList
              documentName={doc.source.name}
              segments={plan.segments}
              activeIds={activeIds}
              selectedId={selected?.id ?? null}
              onSelect={(segment) => {
                setSelected(segment);
              }}
              onPlayFrom={(segmentId) => playFromSegment(segmentId)}
            />
            <DetailPanel
              segment={selected}
              document={doc}
              metrics={metrics}
              chunkCount={chunks.length}
              health={health}
              docSource={docSource}
            />
          </div>

          <PlayerBar
            state={playerState}
            chunkIndex={chunkIndex}
            chunkCount={chunks.length}
            rate={rate}
            onPlayPause={playPause}
            onStop={() => playerRef.current?.stop()}
            onPrev={() => playerRef.current?.previous()}
            onNext={() => playerRef.current?.next()}
            onSeek={(index) => void playerRef.current?.seekToChunk(index)}
            onRate={changeRate}
            disabled={chunks.length === 0}
          />
        </>
      )}

      {phase === "empty" && (
        <p className="empty">
          Load a document to start. Extraction runs locally; only normalized spoken chunks
          are sent to the server for synthesis. See <code>docs/privacy.md</code>.
        </p>
      )}
      <footer className="footer">
        NaN is development/validation infrastructure, not production infrastructure.
        Listen mode is deterministic; Adapted (LLM) mode is not implemented. Provenance ≠
        semantic faithfulness.
      </footer>
    </main>
  );
}
