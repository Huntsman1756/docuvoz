"use client";

import { useCallback, useMemo } from "react";
import { getRecentDocuments, type RecentDocument } from "@/lib/recent-documents";
import { SUPPORTED_FORMATS_LABEL } from "@/adapters/document-parsers/adapter-registry";
import type { CorpusManifest } from "@/lib/corpus";

interface Props {
  onSelectFile: (file: File) => void;
  onLoadFixture?: (pdfPath: string, title: string) => void;
  corpus?: CorpusManifest | null;
  onFingerprint?: (fp: string) => void;
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
    (recent: RecentDocument) => {
      const input = document.createElement("input");
      input.type = "file";
      input.accept = ".pdf,.epub,.docx,.txt,.md,.html";
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
        onClick={() => {
          const input = document.createElement("input");
          input.type = "file";
          input.accept = ".pdf,.epub,.docx,.txt,.md,.html";
          input.onchange = (e) => {
            const file = (e.target as HTMLInputElement).files?.[0];
            if (file) onSelectFile(file);
          };
          input.click();
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
