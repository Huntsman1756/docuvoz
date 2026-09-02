"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StructuredDocument } from "@/domain/documents/types";
import type { SpokenMode } from "@/domain/spoken/types";
import { buildSpokenPlan } from "@/domain/spoken/pipeline";
import { planChunks } from "@/domain/spoken/speech-plan";
import { extractPdf, sha256Hex } from "@/adapters/document-parsers/browser-loader";
import { hasPdfMagic, validatePdfFile } from "@/lib/ingest";
import { SpeechPlayer, type PlayerState } from "@/lib/speech-player";
import { loadManifest, type CorpusManifest } from "@/lib/corpus";
import { detectLanguage, defaultVoice, voicesFor, type Lang } from "@/lib/voices";
import {
  exportDocumentAudio,
  triggerDownload,
  type ExportProgress,
} from "@/lib/audio-export";

type Phase = "empty" | "extracting" | "ready" | "error";
const RATES = [0.75, 1, 1.25, 1.5, 2];
const MIN_CHUNK_CHARS = 200;

export function Reader() {
  const [corpus, setCorpus] = useState<CorpusManifest | null>(null);
  const [doc, setDoc] = useState<StructuredDocument | null>(null);
  const [phase, setPhase] = useState<Phase>("empty");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [mode, setMode] = useState<SpokenMode>("listen");
  const [langChoice, setLangChoice] = useState<"auto" | Lang>("auto");
  const [voice, setVoice] = useState<string>(() => defaultVoice("es"));
  const [rate, setRate] = useState(1);
  const [playerState, setPlayerState] = useState<PlayerState>("idle");
  const [chunkIndex, setChunkIndex] = useState(0);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);

  const playerRef = useRef<SpeechPlayer | null>(null);
  const exportAbort = useRef<AbortController | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    void loadManifest()
      .then(setCorpus)
      .catch(() => setCorpus(null));
  }, []);

  const docText = useMemo(
    () => (doc ? doc.blocks.map((b) => b.text).join(" ") : ""),
    [doc],
  );
  const effLang: Lang =
    langChoice === "auto" ? (doc ? detectLanguage(docText) : "es") : langChoice;
  const voices = voicesFor(effLang);
  const activeVoice = voices.some((v) => v.id === voice) ? voice : defaultVoice(effLang);

  const plan = useMemo(() => (doc ? buildSpokenPlan(doc, mode) : null), [doc, mode]);
  const chunks = useMemo(
    () => (plan ? planChunks(plan, 400, MIN_CHUNK_CHARS) : []),
    [plan],
  );

  // Rebuild the player whenever the chunk list or chosen voice changes.
  useEffect(() => {
    playerRef.current?.destroy();
    if (chunks.length === 0) {
      playerRef.current = null;
      return;
    }
    const player = new SpeechPlayer(
      chunks,
      {
        onStateChange: setPlayerState,
        onChunkChange: setChunkIndex,
        onMetrics: () => {},
        onError: (code) => setErrorText(`speech error: ${code}`),
      },
      { voice: activeVoice, prefetchDepth: 2 },
    );
    playerRef.current = player;
    return () => player.destroy();
  }, [chunks, activeVoice]);

  useEffect(() => {
    playerRef.current?.setPlaybackRate(rate);
  }, [rate]);

  const openPdf = useCallback(async (data: ArrayBuffer, name: string, language: Lang) => {
    setPhase("extracting");
    setErrorText(null);
    try {
      const hash = await sha256Hex(data);
      const extracted = await extractPdf(data, {
        id: `doc-${hash.slice(0, 12)}`,
        name,
        sha256: hash,
        language,
      });
      setDoc(extracted);
      setPhase("ready");
    } catch (error) {
      setPhase("error");
      setErrorText(
        `No pude leer el PDF: ${error instanceof Error ? error.message : "desconocido"}. ` +
          "Los PDF escaneados (solo imagen) no tienen texto que extraer en el navegador.",
      );
    }
  }, []);

  const onFile = useCallback(
    async (file: File) => {
      const invalid = validatePdfFile(file);
      if (invalid) {
        setPhase("error");
        setErrorText(`Rechazado: ${invalid}`);
        return;
      }
      const buffer = await file.arrayBuffer();
      if (!hasPdfMagic(new Uint8Array(buffer))) {
        setPhase("error");
        setErrorText("Rechazado: no es un PDF (cabecera inválida).");
        return;
      }
      await openPdf(buffer, file.name, langChoice === "auto" ? "es" : langChoice);
    },
    [langChoice, openPdf],
  );

  const loadFixture = useCallback(
    async (pdfPath: string, title: string) => {
      setPhase("extracting");
      setErrorText(null);
      try {
        const res = await fetch(pdfPath);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        await openPdf(
          await res.arrayBuffer(),
          `${title}.pdf`,
          langChoice === "auto" ? "es" : langChoice,
        );
      } catch (error) {
        setPhase("error");
        setErrorText(
          `No se pudo cargar el ejemplo: ${error instanceof Error ? error.message : "desconocido"}`,
        );
      }
    },
    [langChoice, openPdf],
  );

  const playPause = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (playerState === "playing") player.pause();
    else if (playerState === "paused") player.resume();
    else void player.play(0);
  }, [playerState]);

  const runExport = useCallback(async () => {
    if (chunks.length === 0) return;
    setExporting(true);
    setExportError(null);
    setExportProgress({ done: 0, total: chunks.length });
    exportAbort.current = new AbortController();
    try {
      const blob = await exportDocumentAudio(
        chunks.map((c) => c.text),
        {
          voice: activeVoice,
          signal: exportAbort.current.signal,
          onProgress: setExportProgress,
        },
      );
      const base = (doc?.source.name ?? "documento").replace(/\.[^.]+$/, "");
      triggerDownload(blob, `${base}-${mode}-${activeVoice}.wav`);
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        setExportError("Descarga cancelada.");
      } else {
        setExportError(
          `Error al exportar: ${error instanceof Error ? error.message : "desconocido"}`,
        );
      }
    } finally {
      setExporting(false);
      setExportProgress(null);
      exportAbort.current = null;
    }
  }, [chunks, activeVoice, mode, doc]);

  const cancelExport = useCallback(() => exportAbort.current?.abort(), []);

  const totalChunks = chunks.length;
  const generatingFirst = playerState === "loading" && chunkIndex === 0;
  const progressPct =
    playerState === "ended"
      ? 100
      : totalChunks > 0
        ? Math.round(
            ((chunkIndex +
              (playerState === "playing" || playerState === "paused" ? 1 : 0)) /
              totalChunks) *
              100,
          )
        : 0;
  const exportPct = exportProgress
    ? Math.round((exportProgress.done / exportProgress.total) * 100)
    : 0;

  return (
    <main className="lab">
      <header className="lab-header">
        <div>
          <h1>Lector de documentos</h1>
          <p className="sub">
            Sube un PDF y escúchalo.{" "}
            {plan
              ? `Motor ${plan.spokenEngineVersion}.`
              : "El PDF se procesa en tu navegador."}
          </p>
        </div>
        <div className="provider">
          <Link href="/lab" className="chip">
            Modo laboratorio →
          </Link>
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
            accept="application/pdf,.pdf"
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
            Selecciona tu PDF
          </button>
          <span className="hint">
            o arrástralo aquí · procesado 100% en tu navegador · máx 25 MB
          </span>
        </div>
        {corpus && corpus.entries.length > 0 && (
          <div className="corpus">
            <span className="corpus-label">ejemplos:</span>
            {corpus.entries.map((entry) => (
              <button
                key={entry.id}
                type="button"
                className="chip"
                title={entry.description}
                onClick={() => void loadFixture(entry.pdf, entry.title)}
              >
                {entry.title}
              </button>
            ))}
          </div>
        )}
      </section>

      {phase === "extracting" && <div className="status">⏳ Leyendo el documento…</div>}
      {errorText && (
        <div className="status error" role="alert">
          ✖ {errorText}
        </div>
      )}

      {phase === "ready" && plan && (
        <>
          <section className="controls">
            <div className="modes" role="radiogroup" aria-label="Modo">
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
            </div>
            <label className="rate">
              Idioma
              <select
                aria-label="idioma"
                value={langChoice}
                onChange={(e) => setLangChoice(e.target.value as "auto" | Lang)}
              >
                <option value="auto">Automático{doc ? ` (${effLang})` : ""}</option>
                <option value="es">Español</option>
                <option value="en">English</option>
              </select>
            </label>
            <label className="rate">
              Voz
              <select
                aria-label="voz"
                value={activeVoice}
                onChange={(e) => setVoice(e.target.value)}
              >
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="rate">
              Velocidad
              <select
                aria-label="velocidad de reproducción"
                value={rate}
                onChange={(e) => setRate(Number(e.target.value))}
              >
                {RATES.map((r) => (
                  <option key={r} value={r}>
                    {r}×
                  </option>
                ))}
              </select>
            </label>
          </section>

          <section className="controls">
            <button
              type="button"
              className="primary"
              onClick={playPause}
              disabled={chunks.length === 0}
            >
              {playerState === "playing" ? "⏸ Pausar" : "▶ Escuchar"}
            </button>
            <button
              type="button"
              onClick={() => (exporting ? cancelExport() : void runExport())}
              disabled={chunks.length === 0}
            >
              {exporting ? "⏹ Cancelar" : "⬇ Descargar audio"}
            </button>
            {playerState !== "idle" && !exporting && (
              <span className="hint" aria-live="polite">
                {generatingFirst
                  ? "Generando audio inicial…"
                  : `chunk ${Math.min(chunkIndex + 1, totalChunks)} / ${totalChunks}`}
              </span>
            )}
            {exporting && (
              <span className="hint" aria-live="polite">
                Generando descarga… {exportPct}% ({exportProgress?.done ?? 0}/
                {exportProgress?.total ?? 0})
              </span>
            )}
            {exportError && <span className="stat-warn">{exportError}</span>}
          </section>

          <div
            className="progress"
            role="progressbar"
            aria-valuenow={exporting ? exportPct : progressPct}
            aria-valuemin={0}
            aria-valuemax={100}
            style={{
              height: 6,
              background: "#e5e7eb",
              borderRadius: 3,
              overflow: "hidden",
              margin: "4px 0",
            }}
          >
            <div
              style={{
                height: "100%",
                width: `${exporting ? exportPct : progressPct}%`,
                background: generatingFirst ? "#f59e0b" : "#2563eb",
                transition: "width 200ms ease",
              }}
            />
          </div>

          <div className="player" aria-label="reproductor">
            <button
              type="button"
              aria-label="segmento anterior"
              disabled={chunks.length === 0}
              onClick={() => playerRef.current?.previous()}
            >
              ⏮
            </button>
            <button
              type="button"
              aria-label="segmento siguiente"
              disabled={chunks.length === 0}
              onClick={() => playerRef.current?.next()}
            >
              ⏭
            </button>
            <button
              type="button"
              aria-label="stop"
              disabled={chunks.length === 0}
              onClick={() => playerRef.current?.stop()}
            >
              ⏹
            </button>
            <input
              type="range"
              min={0}
              max={Math.max(0, totalChunks - 1)}
              value={chunkIndex}
              disabled={chunks.length === 0}
              aria-label="posición"
              onChange={(e) =>
                void playerRef.current?.seekToChunk(Number(e.target.value))
              }
            />
            <span className="chunk-info">
              chunk {Math.min(chunkIndex + 1, totalChunks)} / {totalChunks}
            </span>
          </div>

          <section className="panel" style={{ marginTop: 12 }}>
            <p className="sub">
              Documento: {doc?.source.name} · {plan.stats.segments} segmentos ·{" "}
              {totalChunks} fragmentos de audio ·{" "}
              {effLang === "en" ? "English" : "Español"} / {activeVoice}
            </p>
            <ol style={{ lineHeight: 1.7, paddingInlineStart: "1.2rem" }}>
              {plan.segments
                .filter((s) => !s.muted && s.text.trim().length > 0)
                .slice(0, 40)
                .map((s) => (
                  <li key={s.id}>{mode === "literal" ? s.sourceText : s.text}</li>
                ))}
            </ol>
            {plan.segments.length > 40 && (
              <p className="hint">… y {plan.segments.length - 40} segmentos más.</p>
            )}
          </section>
        </>
      )}

      {phase === "empty" && (
        <p className="empty">
          Sube un PDF (o carga un ejemplo) para generar su versión escuchable. Con{" "}
          <b>Listen</b> el texto se reescribe para sonar natural; con <b>Literal</b> se
          lee tal cual.
        </p>
      )}
    </main>
  );
}
