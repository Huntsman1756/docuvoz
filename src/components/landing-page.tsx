"use client";

import { useCallback, useMemo } from "react";
import { getRecentDocuments, type RecentDocument } from "@/lib/recent-documents";
import { SUPPORTED_FORMATS_LABEL } from "@/adapters/document-parsers/adapter-registry";
import type { CorpusManifest } from "@/lib/corpus";
import {
  supportsFileSystemAccess,
  getFileHandle,
  ensureReadPermission,
} from "@/lib/file-handle-persistence";

interface Props {
  onSelectFile: (file: File, handle?: FileSystemFileHandle) => void;
  onLoadFixture?: (pdfPath: string, title: string) => void;
  corpus?: CorpusManifest | null;
  onFingerprint?: (fp: string) => void;
}

const FILE_ACCEPT = ".pdf,.epub,.docx,.txt,.md,.html";

/** Show the browser-native file picker when supported; otherwise fall back. */
async function pickFile(): Promise<{ file: File; handle?: FileSystemFileHandle } | null> {
  if (supportsFileSystemAccess()) {
    try {
      const [handle] = await window.showOpenFilePicker({
        multiple: false,
        types: [
          {
            description: "Documentos",
            accept: {
              "application/pdf": [".pdf"],
              "application/epub+zip": [".epub"],
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [
                ".docx",
              ],
              "text/plain": [".txt", ".md"],
              "text/html": [".html"],
            },
          },
        ],
      });
      const file = await handle.getFile();
      return { file, handle };
    } catch (error) {
      // AbortError = user cancelled the picker; anything else falls through
      // to the plain input fallback rather than silently failing.
      if ((error as DOMException)?.name === "AbortError") return null;
    }
  }
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = FILE_ACCEPT;
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) resolve({ file });
      else resolve(null);
    };
    input.click();
  });
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return "ahora mismo";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `hace ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `hace ${hours} h`;
  const days = Math.floor(hours / 24);
  return `hace ${days} días`;
}

function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return "00:00";
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function LandingPage({
  onSelectFile,
  onLoadFixture,
  corpus,
  onFingerprint,
}: Props) {
  const recents = useMemo(() => getRecentDocuments(), []);

  const handleResume = useCallback(
    async (recent: RecentDocument) => {
      // Prefer a persisted browser handle (Chromium File System Access).
      if (supportsFileSystemAccess()) {
        const handle = await getFileHandle(recent.fingerprint);
        if (handle) {
          const granted = await ensureReadPermission(handle);
          if (granted) {
            try {
              const file = await handle.getFile();
              onFingerprint?.(recent.fingerprint);
              onSelectFile(file, handle);
              return;
            } catch {
              // Stale/deleted file: fall through to reselection.
            }
          }
        }
      }
      // Fallback: current file-reselection + content-fingerprint workflow.
      const input = document.createElement("input");
      input.type = "file";
      input.accept = FILE_ACCEPT;
      input.onchange = (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (file) {
          onFingerprint?.(recent.fingerprint);
          onSelectFile(file);
        }
      };
      input.click();
    },
    [onSelectFile, onFingerprint],
  );

  return (
    <section className="reader-hero" aria-label="cargar documento">
      <div className="reader-hero-icon" aria-hidden="true">
        📄
      </div>
      <p className="reader-hero-title">Arrastra un documento aquí o selecciona uno</p>
      <button
        type="button"
        className="reader-hero-btn"
        onClick={async () => {
          const picked = await pickFile();
          if (picked) onSelectFile(picked.file, picked.handle);
        }}
      >
        Seleccionar documento
      </button>
      <p className="reader-hero-hint">
        {SUPPORTED_FORMATS_LABEL} · Procesado local · máximo 50 MB
      </p>

      {corpus && corpus.entries.length > 0 && (
        <div className="reader-examples">
          <span>o prueba con un ejemplo:</span>
          {corpus.entries.map((entry) => (
            <button
              key={entry.id}
              type="button"
              className="reader-example"
              onClick={() => onLoadFixture?.(entry.pdf, entry.title)}
            >
              {entry.title}
            </button>
          ))}
        </div>
      )}

      {recents.length > 0 && (
        <div className="reader-recents">
          <h3 className="reader-recents-title">Documentos recientes</h3>
          <ul className="reader-recents-list" role="list">
            {recents.map((recent) => {
              const hasPosition = recent.lastDocTime != null && recent.lastDocTime > 0;
              return (
                <li key={recent.fingerprint} className="reader-recent-item">
                  <div className="reader-recent-info">
                    <span className="reader-recent-name" title={recent.filename}>
                      {recent.title || recent.filename}
                    </span>
                    <div className="reader-recent-details">
                      <span className="reader-recent-type">
                        {recent.docType.toUpperCase()}
                      </span>
                      {recent.lastSection && (
                        <span className="reader-recent-section">
                          · {recent.lastSection}
                        </span>
                      )}
                      {hasPosition && (
                        <span className="reader-recent-position">
                          · {formatTime(recent.lastDocTime!)}
                        </span>
                      )}
                      <span className="reader-recent-time">
                        {formatTimeAgo(recent.lastOpened)}
                      </span>
                    </div>
                  </div>
                  <button
                    type="button"
                    className="reader-recent-resume"
                    onClick={() => handleResume(recent)}
                    aria-label={`Reanudar ${recent.filename}`}
                    disabled={!hasPosition}
                    title={
                      hasPosition
                        ? `Reanudar desde ${recent.lastSection || "el inicio"}`
                        : "Sin posición guardada"
                    }
                  >
                    {hasPosition ? "Reanudar" : "Cargar"}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </section>
  );
}
