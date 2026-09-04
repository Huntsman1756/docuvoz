"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StructuredDocument } from "@/domain/documents/types";
import type { SpokenMode } from "@/domain/spoken/types";
import { buildSpokenPlan } from "@/domain/spoken/pipeline";
import { planChunks } from "@/domain/spoken/speech-plan";
import { extractPdf, sha256Hex } from "@/adapters/document-parsers/browser-loader";
import { hasPdfMagic, validatePdfFile } from "@/lib/ingest";
import { BufferedSpeechPlayer } from "@/lib/buffered-player";
import type { BufferedPlayerState } from "@/lib/buffered-player";
import type { EngineDescriptor } from "@/lib/speech-player";
import { loadManifest, type CorpusManifest } from "@/lib/corpus";
import {
  detectLanguage,
  defaultVoice,
  ENGINES,
  resolveEngine,
  voicesFor,
  type EngineChoice,
  type EngineId,
  type Lang,
} from "@/lib/voices";
import {
  exportDocumentAudio,
  triggerDownload,
  type ExportProgress,
} from "@/lib/audio-export";
import { deriveReaderPhase, PHASE_LABELS } from "@/lib/reader-phase";

const RATES = [0.75, 1, 1.25, 1.5, 2];
const MIN_CHUNK_CHARS = 200;
/** Spanish narration cadence, for the listen-time estimate only. */
const CHARS_PER_MINUTE = 840;

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function Reader() {
  const [corpus, setCorpus] = useState<CorpusManifest | null>(null);
  const [engines, setEngines] = useState<EngineDescriptor[]>([]);
  const [doc, setDoc] = useState<StructuredDocument | null>(null);
  const [rawPhase, setRawPhase] = useState<
    "empty" | "loading" | "extracting" | "ready" | "error"
  >("empty");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [mode, setMode] = useState<SpokenMode>("listen");
  const [langChoice, setLangChoice] = useState<"auto" | Lang>("auto");
  const [engineChoice, setEngineChoice] = useState<EngineChoice>("auto");
  const [voice, setVoice] = useState<string>(() => defaultVoice("es", "default"));
  const [rate, setRate] = useState(1);
  const [playerState, setPlayerState] = useState<BufferedPlayerState>("idle");
  const [chunkIndex, setChunkIndex] = useState(0);
  const [prep, setPrep] = useState<{ sig: string; ready: number; failed: boolean }>({
    sig: "",
    ready: 0,
    failed: false,
  });
  const [queuedPlay, setQueuedPlay] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportProgress, setExportProgress] = useState<ExportProgress | null>(null);
  const [exportError, setExportError] = useState<string | null>(null);
  const [advanced, setAdvanced] = useState(false);

  const playerRef = useRef<BufferedSpeechPlayer | null>(null);
  const genRef = useRef(0);
  const pendingPlayRef = useRef(false);
  const cancelExportRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeSegRef = useRef<HTMLParagraphElement | null>(null);

  /* ---- current time position (seconds) ---- */
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  /* ---- initialisation ---- */
  useEffect(() => {
    void loadManifest()
      .then(setCorpus)
      .catch(() => setCorpus(null));
    void fetch("/api/health")
      .then((res) => (res.ok ? res.json() : null))
      .then((body: { engines?: EngineDescriptor[] } | null) =>
        setEngines(body?.engines?.filter((e) => e.id in ENGINES) ?? []),
      )
      .catch(() => setEngines([]));
  }, []);

  /* ---- document text for language detection ---- */
  const docText = useMemo(
    () => (doc ? doc.blocks.map((b) => b.text).join(" ") : ""),
    [doc],
  );
  const effLang: Lang =
    langChoice === "auto" ? (doc ? detectLanguage(docText) : "es") : langChoice;
  const availableEngines = useMemo(() => engines.map((e) => e.id as EngineId), [engines]);
  const engineId = resolveEngine(engineChoice, effLang, availableEngines);
  const voices = voicesFor(effLang, engineId);
  const activeVoice = voices.some((v) => v.id === voice)
    ? voice
    : defaultVoice(effLang, engineId);

  /* ---- spoken plan & chunks ---- */
  const plan = useMemo(() => (doc ? buildSpokenPlan(doc, mode) : null), [doc, mode]);
  const chunks = useMemo(
    () => (plan ? planChunks(plan, 400, MIN_CHUNK_CHARS) : []),
    [plan],
  );
  const totalChunks = chunks.length;

  /* ---- preparation progress (signature-stamped) ---- */
  const playerSig = `${doc?.id ?? "-"}|${mode}|${activeVoice}|${engineId}`;
  const prepared = prep.sig === playerSig ? prep.ready : 0;
  const prepareFailed = prep.sig === playerSig && prep.failed;
  const preparing = rawPhase === "ready" && !prepareFailed && prepared < totalChunks;
  const totalChars = useMemo(
    () => chunks.reduce((n, c) => n + c.text.length, 0),
    [chunks],
  );

  /* ---- player lifecycle ---- */
  useEffect(() => {
    playerRef.current?.destroy();
    cancelExportRef.current = true;
    if (chunks.length === 0) {
      playerRef.current = null;
      return;
    }
    const sig = playerSig;
    const player = new BufferedSpeechPlayer(
      chunks,
      {
        onStateChange: (s) => {
          setPlayerState(s);
          if (s === "playing") {
            pendingPlayRef.current = false;
            setQueuedPlay(false);
          }
        },
        onChunkChange: setChunkIndex,
        onMetrics: () => {},
        onTimeUpdate: (pos, dur) => {
          setCurrentTime(pos);
          setDuration(dur);
        },
        onError: (code) => {
          if (code === "prepare_failed") {
            setPrep((p) => ({
              sig,
              ready: p.sig === sig ? p.ready : 0,
              failed: true,
            }));
            if ((playerRef.current?.preparedCount ?? 0) === 0) {
              setErrorText(
                "El servidor de audio no responde. Comprueba que está en " +
                  "marcha y vuelve a pulsar Escuchar.",
              );
            }
            return;
          }
          setErrorText(`No se pudo generar el audio (${code}). Inténtalo de nuevo.`);
        },
        onPreparedChange: (ready) => {
          setPrep({ sig, ready, failed: false });
          if (ready > 0) setErrorText(null);
        },
      },
      { voice: activeVoice, engine: engineId },
    );
    playerRef.current = player;
    player.prepare();
    return () => player.destroy();
  }, [chunks, activeVoice, engineId, playerSig]);

  useEffect(() => {
    playerRef.current?.setPlaybackRate(rate);
  }, [rate]);

  // Auto-start playback when the first chunk is ready and the user requested it.
  useEffect(() => {
    const player = playerRef.current;
    if (player && pendingPlayRef.current && prepared >= 1) {
      void player.play(0);
    }
  }, [prepared]);

  /* ---- document loading ---- */
  const beginLoad = useCallback(() => {
    const gen = ++genRef.current;
    cancelExportRef.current = true;
    setExporting(false);
    setExportProgress(null);
    setExportError(null);
    playerRef.current?.destroy();
    playerRef.current = null;
    pendingPlayRef.current = false;
    setQueuedPlay(false);
    setPlayerState("idle");
    setChunkIndex(0);
    setCurrentTime(0);
    setDuration(0);
    setPrep({ sig: "", ready: 0, failed: false });
    setErrorText(null);
    return gen;
  }, []);

  const analyzeBytes = useCallback(
    async (data: ArrayBuffer, name: string, gen: number) => {
      if (gen !== genRef.current) return;
      setRawPhase("extracting");
      try {
        const hash = await sha256Hex(data);
        const extracted = await extractPdf(data, {
          id: `doc-${hash.slice(0, 12)}`,
          name,
          sha256: hash,
          language: langChoice === "auto" ? "es" : langChoice,
        });
        if (gen !== genRef.current) return;
        setDoc(extracted);
        setRawPhase("ready");
      } catch (error) {
        if (gen !== genRef.current) return;
        setRawPhase("error");
        setErrorText(
          `No se pudo leer el PDF: ${error instanceof Error ? error.message : "desconocido"}. ` +
            "Los PDF escaneados (solo imagen) no tienen texto extraíble.",
        );
      }
    },
    [langChoice],
  );

  const onFile = useCallback(
    async (file: File) => {
      const gen = beginLoad();
      setRawPhase("loading");
      const invalid = validatePdfFile(file);
      if (invalid) {
        setRawPhase("error");
        setErrorText(
          invalid === "file_too_large"
            ? "El PDF supera los 25 MB."
            : invalid === "empty_file"
              ? "El archivo está vacío."
              : "Solo se aceptan archivos PDF.",
        );
        return;
      }
      let buffer: ArrayBuffer;
      try {
        buffer = await file.arrayBuffer();
      } catch {
        if (gen === genRef.current) {
          setRawPhase("error");
          setErrorText("No se pudo leer el archivo.");
        }
        return;
      }
      if (gen !== genRef.current) return;
      if (!hasPdfMagic(new Uint8Array(buffer))) {
        setRawPhase("error");
        setErrorText("Ese archivo no es un PDF válido (cabecera inválida).");
        return;
      }
      await analyzeBytes(buffer, file.name, gen);
    },
    [analyzeBytes, beginLoad],
  );

  const loadFixture = useCallback(
    async (pdfPath: string, title: string) => {
      const gen = beginLoad();
      setRawPhase("loading");
      try {
        const res = await fetch(pdfPath);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const buffer = await res.arrayBuffer();
        await analyzeBytes(buffer, `${title}.pdf`, gen);
      } catch (error) {
        if (gen !== genRef.current) return;
        setRawPhase("error");
        setErrorText(
          `No se pudo cargar el ejemplo: ${error instanceof Error ? error.message : "desconocido"}`,
        );
      }
    },
    [analyzeBytes, beginLoad],
  );

  /* ---- playback ---- */
  const playPause = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    const st = player.currentState;
    if (st === "playing") {
      player.pause();
      return;
    }
    if (st === "paused") {
      player.resume();
      return;
    }
    // During preparation, record the intent — auto-starts when chunk 0 is ready.
    if (player.preparedCount < 1) {
      pendingPlayRef.current = true;
      setQueuedPlay(true);
      return;
    }
    // Playback completed — start from the beginning again.
    if (st === "ended") {
      void player.play(0);
      return;
    }
    // Default: play from the current position (or beginning if idle).
    void player.play(undefined);
  }, []);

  /* ---- export ---- */
  const runExport = useCallback(async () => {
    const player = playerRef.current;
    if (!player || totalChunks === 0 || exporting) return;
    cancelExportRef.current = false;
    setExporting(true);
    setExportError(null);
    setExportProgress({ done: 0, total: totalChunks });
    try {
      const blob = await exportDocumentAudio(totalChunks, (i) => player.blobFor(i), {
        onProgress: setExportProgress,
        isCancelled: () => cancelExportRef.current,
      });
      const base = (doc?.source.name ?? "documento").replace(/\.[^.]+$/, "");
      triggerDownload(blob, `${base}.wav`);
    } catch (error) {
      const cancelled =
        (error instanceof DOMException && error.name === "AbortError") ||
        cancelExportRef.current;
      if (cancelled) setExportError("Descarga cancelada.");
      else
        setExportError(
          `Error al exportar: ${error instanceof Error ? error.message : "desconocido"}`,
        );
    } finally {
      setExporting(false);
      setExportProgress(null);
    }
  }, [doc, exporting, totalChunks]);

  const cancelExport = useCallback(() => {
    cancelExportRef.current = true;
  }, []);

  /* ---- explicit reader phase (product-facing state machine) ---- */
  const firstReady = prepared >= 1 || playerState !== "idle";
  const playable = totalChunks > 0 && rawPhase === "ready";
  const phase = deriveReaderPhase(
    rawPhase,
    playerState,
    preparing,
    firstReady,
    queuedPlay,
    exporting,
    errorText,
  );

  /* ---- progress / percentage helpers ---- */
  const prepPct = totalChunks > 0 ? Math.round((prepared / totalChunks) * 100) : 0;
  const exportPct = exportProgress
    ? Math.round((exportProgress.done / exportProgress.total) * 100)
    : 0;

  /* chunk → segment mapping */
  const chunkOfSegment = useMemo(() => {
    const m = new Map<string, number>();
    chunks.forEach((c, i) =>
      c.segmentIds.forEach((s) => {
        if (!m.has(s)) m.set(s, i);
      }),
    );
    return m;
  }, [chunks]);
  const activeSegments = useMemo(
    () => new Set(chunks[chunkIndex]?.segmentIds ?? []),
    [chunks, chunkIndex],
  );

  useEffect(() => {
    if (playerState === "playing") {
      activeSegRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [chunkIndex, playerState]);

  /* ---- label / state text ---- */
  const stateLabel = PHASE_LABELS[phase];
  const statusText =
    phase === "preparing" && firstReady
      ? `Preparando audio · ${prepPct} %`
      : phase === "ready"
        ? prepPct < 100
          ? `Audio listo · ${prepPct} %`
          : "Audio listo"
        : stateLabel;

  const barPct = exporting ? exportPct : playerState === "idle" ? prepPct : 0;

  // Determine if we're in a buffering state (mid-document)
  const isBuffering = playerState === "buffering" || playerState === "loading";
  const isInitialBuffer =
    playerState === "loading" || (playerState === "buffering" && currentTime === 0);

  const playLabel = exporting
    ? "Descargando…"
    : queuedPlay || playerState === "loading"
      ? "Preparando…"
      : playerState === "playing"
        ? "Pausar"
        : playerState === "paused"
          ? "Continuar"
          : playerState === "ended"
            ? "Escuchar de nuevo"
            : "Escuchar";

  /* ========== RENDER ========== */
  return (
    <main
      className="reader"
      data-phase={phase}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => {
        e.preventDefault();
        const file = e.dataTransfer.files?.[0];
        if (file) void onFile(file);
      }}
    >
      {/* ——— Header ——— */}
      <header className="reader-header">
        <div>
          <h1>
            <span className="brand-icon">📖</span> DocuVoz
          </h1>
          <p className="reader-tag">Escucha tus documentos de forma natural</p>
        </div>
        <Link href="/lab" className="reader-lablink">
          Laboratorio
        </Link>
      </header>

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

      {/* ——— Empty state ——— */}
      {phase === "empty" && (
        <section className="reader-hero" aria-label="cargar documento">
          <div className="reader-hero-icon" aria-hidden="true">
            📄
          </div>
          <p className="reader-hero-title">Arrastra un PDF aquí o selecciona uno</p>
          <button
            type="button"
            className="reader-hero-btn"
            onClick={() => fileInputRef.current?.click()}
          >
            Seleccionar PDF
          </button>
          <p className="reader-hero-hint">
            Procesado local en tu navegador · máximo 25 MB · no se sube nada a internet
          </p>
          {corpus && corpus.entries.length > 0 && (
            <div className="reader-examples">
              <span>o prueba con un ejemplo:</span>
              {corpus.entries.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  className="reader-example"
                  onClick={() => void loadFixture(entry.pdf, entry.title)}
                >
                  {entry.title}
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {/* ——— Loading / extracting state ——— */}
      {(phase === "loading" || phase === "extracting") && (
        <section className="reader-hero" aria-live="polite">
          <div className="reader-hero-icon reader-loading" aria-hidden="true">
            …
          </div>
          <p className="reader-hero-title">{statusText}</p>
          <p className="reader-hero-hint">
            {phase === "loading"
              ? "Leyendo el archivo…"
              : "Extrayendo el texto en tu navegador. El audio se preparará después."}
          </p>
        </section>
      )}

      {/* ——— Error state (outside of extracting/loading) ——— */}
      {errorText && phase !== "extracting" && phase !== "loading" && (
        <p className="reader-error" role="alert">
          {errorText}
        </p>
      )}

      {/* ——— Loaded-document state ——— */}
      {phase !== "empty" && phase !== "loading" && phase !== "extracting" && plan && (
        <>
          {/* Document meta bar */}
          <article className="reader-doc">
            <div>
              <h2 className="reader-doc-name" title={doc?.source.name}>
                {doc?.source.name}
              </h2>
              <p className="reader-doc-meta">
                {doc?.source.pageCount != null && <>{doc.source.pageCount} páginas · </>}≈{" "}
                {Math.max(1, Math.round(totalChars / CHARS_PER_MINUTE))} min ·{" "}
                {effLang === "en" ? "English" : "Español"} ·{" "}
                {voices.find((v) => v.id === activeVoice)?.label.split("—")[0] ??
                  activeVoice}
              </p>
            </div>
            <button
              type="button"
              className="reader-change"
              onClick={() => fileInputRef.current?.click()}
              aria-label="cambiar documento"
            >
              Cambiar
            </button>
          </article>

          {/* Settings */}
          <section className="reader-settings" aria-label="ajustes de reproducción">
            <label className="setting-main">
              <span>Idioma</span>
              <select
                aria-label="idioma"
                value={langChoice}
                onChange={(e) => setLangChoice(e.target.value as "auto" | Lang)}
              >
                <option value="auto">
                  {langChoice === "auto"
                    ? `Auto (${effLang === "en" ? "English" : "Español"})`
                    : langChoice === "es"
                      ? "Español"
                      : "English"}
                </option>
                <option value="es">Español</option>
                <option value="en">English</option>
              </select>
            </label>
            <label className="setting-main">
              <span>Modo</span>
              <select
                aria-label="modo de lectura"
                value={mode}
                onChange={(e) => setMode(e.target.value as SpokenMode)}
              >
                <option value="listen">Listen</option>
                <option value="literal">Literal</option>
              </select>
            </label>
            <label className="setting-main">
              <span>Velocidad</span>
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

            {/* Advanced: engine + voice */}
            <div className="reader-settings-expand">
              <button
                type="button"
                className="reader-settings-toggle"
                onClick={() => setAdvanced((a) => !a)}
                aria-expanded={advanced}
              >
                {advanced ? "▲ Opciones avanzadas" : "▼ Opciones avanzadas"}
              </button>
              {advanced && (
                <div className="reader-settings-advanced">
                  <label>
                    <span>Motor</span>
                    <select
                      aria-label="motor de voz"
                      value={engineChoice}
                      onChange={(e) => setEngineChoice(e.target.value as EngineChoice)}
                    >
                      <option value="auto">Automático</option>
                      {engines.map((e) => (
                        <option key={e.id} value={e.id}>
                          {ENGINES[e.id as EngineId]?.label ?? e.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    <span>Voz</span>
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
                </div>
              )}
            </div>
          </section>

          {/* Primary play area */}
          <section className="reader-primary" aria-label="reproducción">
            <button
              type="button"
              className="reader-play"
              onClick={playPause}
              disabled={!playable}
              aria-label={playLabel}
            >
              {playLabel}
            </button>
            <p className="reader-status" aria-live="polite">
              {exporting ? `Preparando la descarga · ${exportPct} %` : statusText}
            </p>
            <div
              className="reader-bar"
              role="progressbar"
              aria-valuenow={barPct}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-label={exporting ? "progreso de descarga" : "progreso de audio"}
            >
              <div
                className={`reader-bar-fill ${exporting ? "export" : preparing && !firstReady ? "prepare" : ""}`}
                style={{ width: `${barPct}%` }}
              />
            </div>
            {exportError && <p className="reader-note">{exportError}</p>}
          </section>

          {/* Document text with live highlighting */}
          <section className="reader-text" aria-label="texto del documento">
            {plan.segments
              .filter((s) => !s.muted && s.text.trim().length > 0)
              .map((s) => {
                const active = activeSegments.has(s.id);
                const target = chunkOfSegment.get(s.id) ?? 0;
                return (
                  <p
                    key={s.id}
                    ref={(el) => {
                      if (active) activeSegRef.current = el;
                    }}
                    className={active ? "reader-seg active" : "reader-seg"}
                    onClick={() => void playerRef.current?.seekToChunk(target)}
                    title="Ir a este punto"
                  >
                    {mode === "literal" ? s.sourceText : s.text}
                  </p>
                );
              })}
          </section>
        </>
      )}

      {/* ——— Non-blocking export progress (small bar) ——— */}
      {exporting && (
        <div className="reader-export-bar" aria-label="exportación en progreso">
          <div className="reader-export-fill" style={{ width: `${exportPct}%` }} />
          <span className="reader-export-label">
            {exportProgress ? `${exportProgress.done}/${exportProgress.total}` : ""}
          </span>
          <button type="button" className="reader-export-cancel" onClick={cancelExport}>
            ✕
          </button>
        </div>
      )}

      {/* ——— Sticky transport bar ——— */}
      {playable && (
        <div className="reader-transport" aria-label="reproductor">
          <button
            type="button"
            aria-label="fragmento anterior"
            onClick={() => playerRef.current?.previous()}
            disabled={!firstReady}
          >
            ⏮
          </button>
          <button
            type="button"
            className="reader-transport-play"
            aria-label={
              queuedPlay || playerState === "loading"
                ? "preparando"
                : "reproducir o pausar"
            }
            onClick={playPause}
          >
            {playerState === "playing"
              ? "❚❚"
              : queuedPlay || playerState === "loading"
                ? "⏳"
                : "▶"}
          </button>
          <button
            type="button"
            aria-label="fragmento siguiente"
            onClick={() => playerRef.current?.next()}
            disabled={!firstReady}
          >
            ⏭
          </button>
          <input
            type="range"
            min={0}
            max={Math.max(0.01, duration)}
            value={currentTime}
            disabled={!firstReady || playerState === "buffering"}
            onChange={(e) => playerRef.current?.seekByTime(Number(e.target.value))}
            aria-label="barra de progreso"
            className="reader-seek-bar"
          />
          <span className="reader-transport-time" aria-label="tiempo">
            {formatTime(currentTime)} / {formatTime(duration)}
          </span>
          <span className="reader-transport-rate" aria-label="velocidad">
            {rate}×
          </span>
          {isBuffering && (
            <span
              className="reader-buffering"
              aria-label="preparando siguiente fragmento"
            >
              {isInitialBuffer ? "Preparando…" : "…"}
            </span>
          )}
          <button
            type="button"
            className="reader-download"
            aria-label={exporting ? "cancelar descarga" : "descargar audio"}
            onClick={() => (exporting ? cancelExport() : void runExport())}
          >
            {exporting ? "Cancelando…" : "⬇ Audio"}
          </button>
        </div>
      )}
    </main>
  );
}
