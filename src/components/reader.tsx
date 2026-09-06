"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { StructuredDocument } from "@/domain/documents/types";
import type { SpokenMode } from "@/domain/spoken/types";
import { buildProductSpokenPlan as buildSpokenPlan } from "@/lib/product-spoken-plan";
import { planChunks } from "@/domain/spoken/speech-plan";
import {
  resolveAdapter,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_FORMATS_LABEL,
} from "@/adapters/document-parsers/adapter-registry";
import { validateDocumentFile } from "@/lib/ingest";
import type { TocEntry } from "@/domain/documents/types";
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
  ExportCancelledError,
  type ExportFormat,
  type ExportProgress,
} from "@/lib/export";
import { ExportDialog } from "@/components/export-dialog";
import { deriveReaderPhase, PHASE_LABELS } from "@/lib/reader-phase";
import {
  addRecentDocument,
  updateRecentPosition,
  computeContentFingerprint,
} from "@/lib/recent-documents";
import {
  savePosition,
  loadPosition,
  type SavedPosition,
} from "@/lib/position-persistence";
import { storeFileHandle } from "@/lib/file-handle-persistence";
import { createSpeechTransport } from "@/lib/speech-transport";
import { isDesktop, desktopInvoke } from "@/lib/desktop-bridge";
import {
  desktopStateGet,
  desktopStateSet,
} from "@/lib/desktop-app-state";
import { LandingPage } from "@/components/landing-page";

const RATES = [0.75, 1, 1.25, 1.5, 2];
const MIN_CHUNK_CHARS = 200;
/** Spanish narration cadence, for the listen-time estimate only. */
const CHARS_PER_MINUTE = 840;

/**
 * Desktop-only preference read (app-data mirror, hydrated by DesktopGate
 * before render — so lazy state initializers see the stored value).
 * Returns undefined on the web build.
 */
function readDesktopPref(key: string): unknown {
  if (!isDesktop()) return undefined;
  const saved = desktopStateGet("settings") as Record<string, unknown> | undefined;
  return saved?.[key];
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

function formatTimeRemaining(
  totalDuration: number,
  elapsed: number,
  rate: number,
): string {
  if (!isFinite(totalDuration) || totalDuration <= 0) return "00:00";
  const remaining = (totalDuration - elapsed) / Math.max(rate, 0.1);
  if (remaining <= 0) return "00:00";
  return formatTime(remaining);
}

export function Reader() {
  const [corpus, setCorpus] = useState<CorpusManifest | null>(null);
  const [engines, setEngines] = useState<EngineDescriptor[]>([]);
  const [doc, setDoc] = useState<StructuredDocument | null>(null);
  const [rawPhase, setRawPhase] = useState<
    "empty" | "loading" | "extracting" | "ready" | "error"
  >("empty");
  const [errorText, setErrorText] = useState<string | null>(null);
  const [mode, setMode] = useState<SpokenMode>(() => {
    const v = readDesktopPref("mode");
    return v === "listen" || v === "literal" ? v : "listen";
  });
  const [langChoice, setLangChoice] = useState<"auto" | Lang>(() => {
    const v = readDesktopPref("langChoice");
    return v === "auto" || v === "es" || v === "en" ? v : "auto";
  });
  const [engineChoice, setEngineChoice] = useState<EngineChoice>(() => {
    const v = readDesktopPref("engineChoice");
    // Availability is normalized later by resolveEngine() when unavailable.
    return v === "auto" || v === "default" || v === "edge" ? v : "auto";
  });
  const [voice, setVoice] = useState<string>(() => {
    const v = readDesktopPref("voice");
    return typeof v === "string" && v ? v : defaultVoice("es", "default");
  });
  const [rate, setRate] = useState(() => {
    const v = readDesktopPref("rate");
    return typeof v === "number" && RATES.includes(v) ? v : 1;
  });
  const rateRef = useRef(rate);
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
  const [showExportDialog, setShowExportDialog] = useState(false);
  const [advanced, setAdvanced] = useState(false);
  const [showToc, setShowToc] = useState(false);
  // Auto-scroll follow state: suspended when the user scrolls away manually.
  const [followSuspended, setFollowSuspended] = useState(false);
  // Provider metadata from /api/health has resolved; only then do we build the
  // player so "auto" resolves once to its final engine/voice (no rebuild churn).
  const [providerReady, setProviderReady] = useState(false);
  // Desktop-only: NAN service configuration (URL non-secret in app-data,
  // key in the OS keyring — never rendered back).
  const [nanConfigured, setNanConfigured] = useState<boolean | null>(null);
  const [nanBaseUrl, setNanBaseUrl] = useState(() => {
    const v = readDesktopPref("nanBaseUrl");
    return typeof v === "string" ? v : "";
  });
  const [nanKeyInput, setNanKeyInput] = useState("");
  const [nanNotice, setNanNotice] = useState<string | null>(null);
  // AUTO fallback (Edge unavailable → real standard engine, once, with notice).
  const [edgeNotice, setEdgeNotice] = useState<string | null>(null);
  const edgeFallbackUsedRef = useRef(false);

  // Recent documents and position persistence
  const [fingerprint, setFingerprint] = useState<string | null>(null);
  const [savedPosition, setSavedPosition] = useState<SavedPosition | null>(null);
  const positionSaveTimerRef = useRef<NodeJS.Timeout | null>(null);

  const playerRef = useRef<BufferedSpeechPlayer | null>(null);
  const genRef = useRef(0);
  const pendingPlayRef = useRef(false);
  const cancelExportRef = useRef(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const activeSegRef = useRef<HTMLParagraphElement | null>(null);
  const positionRestoredRef = useRef(false);
  const enginesRef = useRef<EngineDescriptor[]>([]);

  /* ---- current time position (seconds) ---- */
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);

  /* ---- initialisation ---- */
  useEffect(() => {
    void loadManifest()
      .then(setCorpus)
      .catch(() => setCorpus(null));
    // Through the transport seam: the web build keeps GET /api/health; the
    // desktop build proxies the sidecar's /health through the Tauri bridge.
    void createSpeechTransport()
      .health()
      .then((body) => setEngines(body.engines?.filter((e) => e.id in ENGINES) ?? []))
      .catch(() => setEngines([]))
      .finally(() => setProviderReady(true));
  }, []);

  /* ---- desktop: keyring state for the optional NaN service ---- */
  useEffect(() => {
    if (!isDesktop()) return;
    let live = true;
    void desktopInvoke<boolean>("desktop_nan_key_configured")
      .then((v) => {
        if (live) setNanConfigured(v);
      })
      .catch(() => {
        if (live) setNanConfigured(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const saveDesktopSetting = useCallback((patch: Record<string, unknown>) => {
    if (!isDesktop()) return;
    const current = (desktopStateGet("settings") as Record<string, unknown>) ?? {};
    desktopStateSet("settings", { ...current, ...patch });
  }, []);

  const handleNanSave = useCallback(async () => {
    setNanNotice(null);
    try {
      if (nanKeyInput.trim().length > 0) {
        await desktopInvoke("desktop_set_nan_key", { key: nanKeyInput.trim() });
      }
      saveDesktopSetting({ nanBaseUrl: nanBaseUrl.trim() });
      setNanConfigured(true);
      setNanKeyInput("");
      setNanNotice("Guardado. Se aplicará la próxima vez que inicies DocuVoz.");
    } catch {
      setNanNotice("No se pudo guardar la clave.");
    }
  }, [nanKeyInput, nanBaseUrl, saveDesktopSetting]);

  const handleNanClear = useCallback(async () => {
    setNanNotice(null);
    try {
      await desktopInvoke("desktop_clear_nan_key");
      saveDesktopSetting({ nanBaseUrl: "" });
      setNanBaseUrl("");
      setNanConfigured(false);
      setNanNotice("Clave eliminada. Se aplicará la próxima vez que inicies DocuVoz.");
    } catch {
      setNanNotice("No se pudo eliminar la clave.");
    }
  }, [saveDesktopSetting]);

  /* ---- document text for language detection ---- */
  const docText = useMemo(
    () => (doc ? doc.blocks.map((b) => b.text).join(" ") : ""),
    [doc],
  );
  const effLang: Lang =
    langChoice === "auto" ? (doc ? detectLanguage(docText) : "es") : langChoice;
  const availableEngines = useMemo(() => engines.map((e) => e.id as EngineId), [engines]);

  useEffect(() => {
    enginesRef.current = engines;
  }, [engines]);
  const engineId = resolveEngine(engineChoice, effLang, availableEngines);
  const voices = voicesFor(effLang, engineId);
  const activeVoice = voices.some((v) => v.id === voice)
    ? voice
    : defaultVoice(effLang, engineId);

  /* ---- format label ---- */
  const formatLabel = useMemo(() => {
    if (!doc) return "";
    const parser = doc.parser;
    if (parser.includes("pdf")) return "PDF";
    if (parser.includes("epub")) return "EPUB";
    if (parser.includes("docx")) return "DOCX";
    if (parser.includes("markdown")) return "Markdown";
    if (parser.includes("html")) return "HTML";
    if (parser.includes("txt")) return "TXT";
    return doc.source.name.split(".").pop()?.toUpperCase() ?? "";
  }, [doc]);

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

  /* ---- TOC navigation ---- */
  const toc = doc?.toc;
  const activeTocIndex = useMemo(() => {
    if (!toc || !plan) return -1;
    const seg = plan.segments.find((s) => chunks[chunkIndex]?.segmentIds.includes(s.id));
    if (!seg) return -1;
    const blockOrder =
      seg.provenance.blockIds.length > 0
        ? (doc?.blocks.find((b) => b.id === seg.provenance.blockIds[0])?.order ?? -1)
        : -1;
    let best = -1;
    for (let i = 0; i < toc.length; i++) {
      if (toc[i].blockIndex <= blockOrder) best = i;
    }
    return best;
  }, [toc, plan, chunks, chunkIndex, doc]);

  const navigateToToc = useCallback(
    (entry: TocEntry) => {
      if (!plan || !chunks) return;
      const block = doc?.blocks.find((b) => b.order === entry.blockIndex);
      if (!block) return;
      const seg = plan.segments.find((s) => s.provenance.blockIds.includes(block.id));
      if (!seg) return;
      const chunkIdx = chunks.findIndex((c) => c.segmentIds.includes(seg.id));
      if (chunkIdx >= 0) {
        void playerRef.current?.seekToChunk(chunkIdx);
      }
      setShowToc(false);
    },
    [plan, chunks, doc],
  );

  /* ---- desktop preference persistence (app-data, desktop only) ---- */
  const firstPersistRef = useRef(true);
  useEffect(() => {
    if (!isDesktop()) return;
    // Skip the mount run: initial values come from the mirror (or defaults).
    if (firstPersistRef.current) {
      firstPersistRef.current = false;
      return;
    }
    saveDesktopSetting({ engineChoice, voice, rate, mode, langChoice });
  }, [engineChoice, voice, rate, mode, langChoice, saveDesktopSetting]);

  /* ---- player lifecycle ---- */
  useEffect(() => {
    playerRef.current?.destroy();
    cancelExportRef.current = true;
    if (chunks.length === 0) {
      playerRef.current = null;
      return;
    }
    if (!providerReady) {
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
        onChunkChange: (i) => {
          setChunkIndex(i);
        },
        onMetrics: () => {},
        onTimeUpdate: (pos, dur) => {
          setCurrentTime(pos);
          setDuration(dur);
        },
        onError: (code) => {
          // AUTO fallback: Edge unavailable → switch once to a REAL standard
          // engine (never mock) and surface a small user-visible notice.
          if (
            code === "speech_error" &&
            engineChoice === "auto" &&
            engineId === "edge" &&
            !edgeFallbackUsedRef.current
          ) {
            const standard = enginesRef.current.find((e) => e.id === "default");
            if (standard && standard.provider !== "mock") {
              edgeFallbackUsedRef.current = true;
              setEngineChoice("default");
              setEdgeNotice(
                "La voz Edge no responde; se usará la voz estándar para este documento.",
              );
              return;
            }
          }
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
      {
        voice: activeVoice,
        engine: engineId,
        playbackRate: rateRef.current,
        transport: createSpeechTransport(),
      },
    );
    playerRef.current = player;
    return () => player.destroy();
  }, [chunks, activeVoice, engineId, playerSig, providerReady, engineChoice]);

  useEffect(() => {
    rateRef.current = rate;
    playerRef.current?.setPlaybackRate(rate);
  }, [rate]);

  /* Resume target: when a saved position exists, queued/restored playback
   * starts from the saved chunk, never from chunk 0. */
  const resumeChunk = savedPosition ? (savedPosition.chunkIndex ?? 0) : 0;

  useEffect(() => {
    const player = playerRef.current;
    if (player && pendingPlayRef.current && prepared >= 1) {
      pendingPlayRef.current = false;
      void player.play(resumeChunk);
    }
  }, [prepared, resumeChunk]);

  useEffect(() => {
    const player = playerRef.current;
    if (player && savedPosition && providerReady && !positionRestoredRef.current) {
      const targetChunk = savedPosition.chunkIndex ?? 0;
      if (targetChunk < chunks.length) {
        // Restore the position FIRST, then remain paused. The player fetches
        // the target chunk (and its prefix) and seeks there without autoplay;
        // the user must explicitly press Play to continue.
        positionRestoredRef.current = true;
        void player.seekToChunk(targetChunk, false);
      }
    }
  }, [savedPosition, chunks.length, providerReady]);

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
    positionRestoredRef.current = false;
    edgeFallbackUsedRef.current = false;
    setEdgeNotice(null);
    setQueuedPlay(false);
    setPlayerState("idle");
    setChunkIndex(0);
    setCurrentTime(0);
    setDuration(0);
    setPrep({ sig: "", ready: 0, failed: false });
    setErrorText(null);
    return gen;
  }, []);

  const analyzeFile = useCallback(
    async (
      file: File,
      gen: number,
      origin?: {
        handle?: FileSystemFileHandle;
        desktopPath?: string;
      },
    ) => {
      if (gen !== genRef.current) return;
      setRawPhase("loading");
      try {
        const fp = await computeContentFingerprint(file);
        if (gen !== genRef.current) return;
        setFingerprint(fp);
        // Persist a browser file handle (Chromium web) so the document can be
        // reopened directly later; best-effort and never mandatory. Desktop
        // stores a verified local path on the recent entry instead.
        if (origin?.handle) void storeFileHandle(fp, origin.handle);

        setRawPhase("extracting");
        const resolved = await resolveAdapter(file);
        if (!resolved) {
          if (gen !== genRef.current) return;
          setRawPhase("error");
          setErrorText(
            `Formato no soportado: "${file.name}". Formatos aceptados: ${SUPPORTED_FORMATS_LABEL}.`,
          );
          return;
        }
        const { adapter } = resolved;
        const extracted = await adapter.load(file, {
          id: `doc-${fp}`,
          name: file.name,
          language: langChoice === "auto" ? "es" : langChoice,
        });
        if (gen !== genRef.current) return;

        addRecentDocument(extracted, fp, {}, { path: origin?.desktopPath });

        const saved = await loadPosition(fp);
        setSavedPosition(saved);

        setDoc(extracted);
        setRawPhase("ready");
      } catch (error) {
        if (gen !== genRef.current) return;
        setRawPhase("error");
        const msg = error instanceof Error ? error.message : "desconocido";
        if (msg.includes("Cancel")) return;
        setErrorText(`No se pudo leer el documento: ${msg}`);
      }
    },
    [langChoice],
  );

  const onFile = useCallback(
    async (
      file: File,
      origin?: {
        handle?: FileSystemFileHandle;
        desktopPath?: string;
      },
    ) => {
      const gen = beginLoad();
      setRawPhase("loading");
      const invalid = validateDocumentFile(file);
      if (invalid) {
        setRawPhase("error");
        setErrorText(
          invalid === "file_too_large"
            ? "El documento supera los 50 MB."
            : invalid === "empty_file"
              ? "El archivo está vacío."
              : `Formato no soportado. Formatos aceptados: ${SUPPORTED_FORMATS_LABEL}.`,
        );
        return;
      }
      await analyzeFile(file, gen, origin);
    },
    [analyzeFile, beginLoad],
  );

  const loadFixture = useCallback(
    async (pdfPath: string, title: string) => {
      const gen = beginLoad();
      setRawPhase("loading");
      try {
        const res = await fetch(pdfPath);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const blob = await res.blob();
        const ext = pdfPath.match(/\.[^.]+$/)?.[0] ?? ".pdf";
        const file = new File([blob], `${title}${ext}`, { type: blob.type });
        await analyzeFile(file, gen);
      } catch (error) {
        if (gen !== genRef.current) return;
        setRawPhase("error");
        setErrorText(
          `No se pudo cargar el ejemplo: ${error instanceof Error ? error.message : "desconocido"}`,
        );
      }
    },
    [analyzeFile, beginLoad],
  );

  /* ---- playback ---- */
  const playPause = useCallback(() => {
    const player = playerRef.current;
    if (!player) return;
    if (queuedPlay) return;
    const st = player.currentState;
    if (st === "playing") {
      player.pause();
      if (fingerprint && doc) {
        const currentChunk = chunks[chunkIndex];
        const activeSeg = currentChunk?.segmentIds[0];
        const activeBlock = activeSeg
          ? plan?.segments.find((s) => s.id === activeSeg)?.provenance.blockIds[0]
          : undefined;
        const activeTocEntry = activeTocIndex >= 0 ? toc?.[activeTocIndex] : undefined;

        void savePosition({
          fingerprint,
          sectionId: activeTocEntry?.label,
          sectionLabel: activeTocEntry?.label,
          blockIndex: activeBlock
            ? doc.blocks.find((b) => b.id === activeBlock)?.order
            : undefined,
          docTime: currentTime,
          speed: rate,
          chunkIndex,
          filename: doc.source.name,
        });
        updateRecentPosition(fingerprint, {
          lastSection: activeTocEntry?.label,
          lastPosition: activeBlock
            ? doc.blocks.find((b) => b.id === activeBlock)?.order
            : undefined,
          lastDocTime: currentTime,
          playbackSpeed: rate,
        });
      }
      return;
    }
    if (st === "paused") {
      setFollowSuspended(false);
      player.resume();
      return;
    }
    if (player.preparedCount < 1) {
      player.prepare();
      pendingPlayRef.current = true;
      setQueuedPlay(true);
      setFollowSuspended(false);
      return;
    }
    if (st === "ended") {
      setFollowSuspended(false);
      void player.play(0);
      return;
    }
    setFollowSuspended(false);
    void player.play(undefined);
  }, [
    queuedPlay,
    fingerprint,
    doc,
    chunks,
    chunkIndex,
    plan,
    activeTocIndex,
    toc,
    currentTime,
    rate,
  ]);

  /* ---- export ---- */
  const runExport = useCallback(
    async (format: ExportFormat, title: string, author: string) => {
      const player = playerRef.current;
      if (!player || totalChunks === 0 || exporting) return;
      cancelExportRef.current = false;
      setExporting(true);
      setExportError(null);
      setExportProgress({ done: 0, total: totalChunks });
      try {
        const blob = await exportDocumentAudio(totalChunks, (i) => player.blobFor(i), {
          format,
          metadata: { title: title || undefined, author: author || undefined },
          onProgress: setExportProgress,
          isCancelled: () => cancelExportRef.current,
        });
        const base = (title || (doc?.source.name ?? "documento")).replace(/\.[^.]+$/, "");
        const ext = format === "m4a" ? ".m4a" : format === "mp3" ? ".mp3" : ".wav";
        triggerDownload(blob, `${base}${ext}`);
      } catch (error) {
        const cancelled =
          (error instanceof DOMException && error.name === "AbortError") ||
          error instanceof ExportCancelledError ||
          cancelExportRef.current;
        if (cancelled) setExportError("Descarga cancelada.");
        else
          setExportError(
            `Error al exportar: ${error instanceof Error ? error.message : "desconocido"}`,
          );
      } finally {
        setExporting(false);
        setExportProgress(null);
        // Keep the export dialog open for the whole export so its "Cancelar"
        // button (rendered on top of the transport bar) stays clickable; close
        // it only once the export finishes or is cancelled.
        setShowExportDialog(false);
      }
    },
    [doc, exporting, totalChunks],
  );

  const cancelExport = useCallback(() => {
    cancelExportRef.current = true;
  }, []);

  const openExportDialog = useCallback(() => {
    if (exporting) {
      cancelExport();
    } else {
      setShowExportDialog(true);
    }
  }, [exporting, cancelExport, setShowExportDialog]);

  /* ---- explicit reader phase (product-facing state machine) ---- */
  const firstReady = prepared >= 1 || playerState !== "idle";
  // providerReady is part of playability: without it playerRef is still null
  // and a click would silently do nothing (raced CI failures).
  const playable = totalChunks > 0 && rawPhase === "ready" && providerReady;
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

  /* ---- table / footnote segment markers (structural metadata first) ---- */
  const segmentHasTable = useMemo(() => {
    const m = new Set<string>();
    plan?.segments.forEach((s) => {
      const structural = s.provenance.blockIds.some(
        (bid) => doc?.blocks.find((b) => b.id === bid)?.type === "table-cell",
      );
      // Fallback heuristic only for source formats that genuinely lack a
      // table-cell semantic (e.g. EPUB currently flattens cells to paragraphs).
      if (structural || /(^|\s)(Fila|Row)\s/.test(s.text)) m.add(s.id);
    });
    return m;
  }, [plan, doc]);

  const segmentHasFootnote = useMemo(() => {
    const m = new Set<string>();
    plan?.segments.forEach((s) => {
      const structural = s.provenance.blockIds.some(
        (bid) => doc?.blocks.find((b) => b.id === bid)?.type === "footnote",
      );
      if (structural || / Nota \d+:/.test(s.text)) m.add(s.id);
    });
    return m;
  }, [plan, doc]);

  // Auto-scroll: distinguish programmatic follow-scroll from a manual user
  // scroll so the reader never suppresses its own follow behaviour.
  const programmaticScrollUntilRef = useRef(0);
  const prefersReducedMotionRef = useRef(false);

  useEffect(() => {
    prefersReducedMotionRef.current = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;
  }, []);

  useEffect(() => {
    const handleScroll = () => {
      if (Date.now() < programmaticScrollUntilRef.current) return;
      setFollowSuspended(true);
    };
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  const scrollActiveSegment = useCallback(() => {
    const el = activeSegRef.current;
    if (!el) return;
    programmaticScrollUntilRef.current = Date.now() + 600;
    el.scrollIntoView({
      behavior: prefersReducedMotionRef.current ? "auto" : "smooth",
      block: "center",
    });
  }, []);

  useEffect(() => {
    if (playerState === "playing" && !followSuspended) {
      scrollActiveSegment();
    }
  }, [chunkIndex, playerState, followSuspended, scrollActiveSegment]);

  const returnToCurrentText = useCallback(() => {
    setFollowSuspended(false);
    scrollActiveSegment();
  }, [scrollActiveSegment]);

  /* ---- periodic position save during playback ---- */
  useEffect(() => {
    if (playerState === "playing" && fingerprint && doc) {
      positionSaveTimerRef.current = setInterval(() => {
        if (!fingerprint || !doc || !playerRef.current) return;
        const currentChunk = chunks[chunkIndex];
        const activeSeg = currentChunk?.segmentIds[0];
        const activeBlock = activeSeg
          ? plan?.segments.find((s) => s.id === activeSeg)?.provenance.blockIds[0]
          : undefined;
        const activeTocEntry = activeTocIndex >= 0 ? toc?.[activeTocIndex] : undefined;

        void savePosition({
          fingerprint,
          sectionId: activeTocEntry?.label,
          sectionLabel: activeTocEntry?.label,
          blockIndex: activeBlock
            ? doc.blocks.find((b) => b.id === activeBlock)?.order
            : undefined,
          docTime: currentTime,
          speed: rate,
          chunkIndex,
          filename: doc.source.name,
        });
      }, 30000);
    }

    return () => {
      if (positionSaveTimerRef.current) {
        clearInterval(positionSaveTimerRef.current);
        positionSaveTimerRef.current = null;
      }
    };
  }, [
    playerState,
    fingerprint,
    doc,
    chunks,
    chunkIndex,
    plan,
    activeTocIndex,
    toc,
    currentTime,
    rate,
  ]);

  /* ---- save position on page unload ---- */
  useEffect(() => {
    const handleBeforeUnload = () => {
      if (fingerprint && doc && playerRef.current) {
        const currentChunk = chunks[chunkIndex];
        const activeSeg = currentChunk?.segmentIds[0];
        const activeBlock = activeSeg
          ? plan?.segments.find((s) => s.id === activeSeg)?.provenance.blockIds[0]
          : undefined;
        const activeTocEntry = activeTocIndex >= 0 ? toc?.[activeTocIndex] : undefined;

        void savePosition({
          fingerprint,
          sectionId: activeTocEntry?.label,
          sectionLabel: activeTocEntry?.label,
          blockIndex: activeBlock
            ? doc.blocks.find((b) => b.id === activeBlock)?.order
            : undefined,
          docTime: currentTime,
          speed: rate,
          chunkIndex,
          filename: doc.source.name,
        });
      }
    };

    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => window.removeEventListener("beforeunload", handleBeforeUnload);
  }, [
    fingerprint,
    doc,
    chunks,
    chunkIndex,
    plan,
    activeTocIndex,
    toc,
    currentTime,
    rate,
  ]);

  /* ---- keyboard shortcuts ---- */
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement ||
        (e.target instanceof HTMLElement &&
          (e.target.isContentEditable ||
            e.target.closest('[contenteditable="true"], [contenteditable=""]') !== null))
      ) {
        return;
      }

      const player = playerRef.current;

      switch (e.code) {
        case "Space":
          e.preventDefault();
          playPause();
          break;
        case "ArrowLeft":
          e.preventDefault();
          if (e.shiftKey) {
            player?.previous();
          } else {
            player?.seekBackward(15);
          }
          break;
        case "ArrowRight":
          e.preventDefault();
          if (e.shiftKey) {
            player?.next();
          } else {
            player?.seekForward(30);
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [playPause]);

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

  const isBuffering = playerState === "buffering" || playerState === "loading";
  const isInitialBuffer =
    playerState === "loading" || (playerState === "buffering" && currentTime === 0);

  const isPlaying = playerState === "playing";

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
      data-playing={isPlaying}
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
        accept={SUPPORTED_EXTENSIONS}
        hidden
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) void onFile(file);
          e.target.value = "";
        }}
      />

      {/* ——— Empty state ——— */}
      {phase === "empty" && (
        <LandingPage
          onSelectFile={(file, handle, desktopPath) =>
            void onFile(file, { handle, desktopPath })
          }
          onLoadFixture={(path, title) => void loadFixture(path, title)}
          corpus={corpus}
          onFingerprint={(fp) => setFingerprint(fp)}
        />
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
                {formatLabel && <>{formatLabel} · </>}
                {doc?.source.author && <>{doc.source.author} · </>}
                {doc?.source.pageCount != null && (
                  <>{doc.source.pageCount} secciones · </>
                )}
                ≈ {Math.max(1, Math.round(totalChars / CHARS_PER_MINUTE))} min ·{" "}
                {effLang === "en" ? "English" : "Español"} ·{" "}
                {voices.find((v) => v.id === activeVoice)?.label.split("—")[0] ??
                  activeVoice}
              </p>
            </div>
            <div className="reader-doc-actions">
              {toc && toc.length > 0 && (
                <div className="reader-toc-wrapper">
                  <button
                    type="button"
                    className="reader-toc-toggle"
                    onClick={() => setShowToc((v) => !v)}
                    aria-expanded={showToc}
                    aria-label="navegación por capítulos"
                  >
                    {activeTocIndex >= 0
                      ? toc[activeTocIndex].label.slice(0, 30)
                      : "Capítulos"}
                    {" ▾"}
                  </button>
                  {showToc && (
                    <nav className="reader-toc" aria-label="tabla de contenidos">
                      {toc.map((entry, i) => (
                        <button
                          key={`${entry.label}-${i}`}
                          type="button"
                          className={`reader-toc-item ${i === activeTocIndex ? "active" : ""}`}
                          style={{ paddingLeft: `${entry.depth * 12 + 16}px` }}
                          onClick={() => navigateToToc(entry)}
                        >
                          {i === activeTocIndex && <span className="reader-toc-dot" />}
                          {entry.label}
                        </button>
                      ))}
                    </nav>
                  )}
                </div>
              )}
              <button
                type="button"
                className="reader-change"
                onClick={() => fileInputRef.current?.click()}
                aria-label="cambiar documento"
              >
                Cambiar
              </button>
            </div>
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
                <option value="listen">Escuchar</option>
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
                  {isDesktop() && (
                    <div className="reader-nan-config">
                      <label>
                        <span>Servicio NaN — URL (opcional)</span>
                        <input
                          type="text"
                          aria-label="URL del servicio NaN"
                          value={nanBaseUrl}
                          placeholder="https://…"
                          onChange={(e) => setNanBaseUrl(e.target.value)}
                        />
                      </label>
                      <label>
                        <span>Servicio NaN — clave (se guarda en el gestor de credenciales del sistema)</span>
                        <input
                          type="password"
                          aria-label="clave del servicio NaN"
                          value={nanKeyInput}
                          placeholder={nanConfigured ? "••••••••" : ""}
                          autoComplete="off"
                          onChange={(e) => setNanKeyInput(e.target.value)}
                        />
                      </label>
                      <div className="reader-nan-actions">
                        <button type="button" onClick={() => void handleNanSave()}>
                          Guardar
                        </button>
                        {nanConfigured && (
                          <button type="button" onClick={() => void handleNanClear()}>
                            Eliminar clave
                          </button>
                        )}
                      </div>
                      {nanNotice && <p className="reader-nan-notice">{nanNotice}</p>}
                    </div>
                  )}
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
            {edgeNotice && (
              <p className="reader-note" role="status">
                {edgeNotice}
              </p>
            )}
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
            <div className="reader-text-header">
              <span className="reader-text-label">Texto del documento</span>
              {playerState === "playing" && (
                <span className="reader-text-status" aria-live="polite">
                  <span className="reader-now-playing-dot" /> Reproduciendo
                </span>
              )}
            </div>
            {playerState === "playing" && followSuspended && (
              <button
                type="button"
                className="reader-return"
                onClick={returnToCurrentText}
              >
                Volver al texto actual
              </button>
            )}
            {plan.segments
              .filter((s) => !s.muted && s.text.trim().length > 0)
              .map((s) => {
                const active = activeSegments.has(s.id);
                const target = chunkOfSegment.get(s.id) ?? 0;
                const hasTable = segmentHasTable.has(s.id);
                const hasFootnote = segmentHasFootnote.has(s.id);
                return (
                  <p
                    key={s.id}
                    ref={(el) => {
                      if (active) activeSegRef.current = el;
                    }}
                    className={`reader-seg${active ? " active" : ""}${hasTable ? " reader-seg-table" : ""}${hasFootnote ? " reader-seg-footnote" : ""}`}
                    onClick={() => void playerRef.current?.seekToChunk(target)}
                    title={
                      hasTable
                        ? "Tabla — haz clic para ir"
                        : hasFootnote
                          ? "Nota al pie — haz clic para ir"
                          : "Haz clic para ir a este punto"
                    }
                    aria-label={
                      hasTable
                        ? "Sección con tabla"
                        : hasFootnote
                          ? "Sección con nota al pie"
                          : ""
                    }
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
          <button
            type="button"
            className="reader-export-cancel"
            onClick={cancelExport}
            aria-label="cancelar descarga"
          >
            ✕
          </button>
        </div>
      )}

      {/* ——— Sticky transport bar ——— */}
      {playable && (
        <div className="reader-transport" aria-label="reproductor">
          <button
            type="button"
            className="reader-transport-btn"
            aria-label="fragmento anterior"
            onClick={() => playerRef.current?.previous()}
            disabled={!firstReady}
            title="Fragmento anterior (Shift+←)"
          >
            ⏮
          </button>
          <button
            type="button"
            className="reader-transport-btn reader-transport-seek"
            aria-label="retroceder 15 segundos"
            onClick={() => playerRef.current?.seekBackward(15)}
            disabled={!firstReady}
            title="Retroceder 15 s (←)"
          >
            −15 s
          </button>
          <button
            type="button"
            className={`reader-transport-play ${isBuffering ? "reader-transport-buffering" : ""}`}
            aria-label={
              queuedPlay || playerState === "loading"
                ? "preparando"
                : isPlaying
                  ? "pausar"
                  : "reproducir"
            }
            onClick={playPause}
            title="Reproducir / Pausar (Espacio)"
          >
            <span className="reader-play-indicator" />
            {playerState === "playing"
              ? "❚❚"
              : queuedPlay || playerState === "loading"
                ? "⏳"
                : "▶"}
          </button>
          <button
            type="button"
            className="reader-transport-btn reader-transport-seek"
            aria-label="adelantar 30 segundos"
            onClick={() => playerRef.current?.seekForward(30)}
            disabled={!firstReady}
            title="Adelantar 30 s (→)"
          >
            +30 s
          </button>
          <button
            type="button"
            className="reader-transport-btn"
            aria-label="fragmento siguiente"
            onClick={() => playerRef.current?.next()}
            disabled={!firstReady}
            title="Fragmento siguiente (Shift+→)"
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
            {isPlaying && (
              <span className="reader-transport-remaining">
                {" · "}−{formatTimeRemaining(duration, currentTime, rate)}
              </span>
            )}
          </span>
          <span
            className="reader-transport-rate"
            aria-label="velocidad"
            title="Velocidad"
          >
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
            onClick={openExportDialog}
            title="Descargar audio"
          >
            {exporting ? "Cancelando…" : "⬇ Audio"}
          </button>
        </div>
      )}

      {/* ——— Export dialog (modal popover) ——— */}
      {showExportDialog && (
        <div
          className="export-overlay"
          onClick={() => !exporting && setShowExportDialog(false)}
        >
          <div className="export-overlay-panel" onClick={(e) => e.stopPropagation()}>
            <ExportDialog
              title={doc?.source.name?.replace(/\.[^.]+$/, "") ?? ""}
              author=""
              onExport={(fmt, t, a) => {
                // Leave the dialog open while the export runs; runExport's
                // finally block closes it on completion/cancellation.
                void runExport(fmt, t, a);
              }}
              onCancel={() => {
                if (exporting) cancelExport();
                else setShowExportDialog(false);
              }}
              exporting={exporting}
              progressPct={exportPct}
              error={exportError}
            />
          </div>
        </div>
      )}
    </main>
  );
}
