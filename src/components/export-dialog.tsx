"use client";

import { useCallback, useState } from "react";
import type { ExportFormat } from "@/lib/export/types";

const FORMAT_OPTIONS: { value: ExportFormat; label: string }[] = [
  { value: "mp3", label: "MP3" },
  { value: "m4a", label: "M4A" },
  { value: "wav", label: "WAV" },
];

export interface ExportDialogProps {
  title?: string;
  author?: string;
  onExport: (format: ExportFormat, title: string, author: string) => void;
  onCancel: () => void;
  exporting?: boolean;
  progressPct?: number;
  error?: string | null;
}

export function ExportDialog({
  title: initialTitle = "",
  author: initialAuthor = "",
  onExport,
  onCancel,
  exporting = false,
  progressPct = 0,
  error,
}: ExportDialogProps) {
  const [format, setFormat] = useState<ExportFormat>("mp3");
  const [title, setTitle] = useState(initialTitle);
  const [author, setAuthor] = useState(initialAuthor);

  const handleExport = useCallback(() => {
    onExport(format, title.trim(), author.trim());
  }, [format, title, author, onExport]);

  if (exporting) {
    return (
      <div className="export-dialog" role="dialog" aria-label="exportar audio">
        <p className="export-dialog-status">Preparando audio · {progressPct}%</p>
        <div
          className="export-dialog-bar"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="export-dialog-bar-fill" style={{ width: `${progressPct}%` }} />
        </div>
        {error && <p className="export-dialog-error">{error}</p>}
        <button type="button" className="export-dialog-cancel" onClick={onCancel}>
          Cancelar
        </button>
      </div>
    );
  }

  return (
    <div className="export-dialog" role="dialog" aria-label="exportar audio">
      <div className="export-dialog-row">
        <span className="export-dialog-label">Formato</span>
        <div className="export-dialog-formats">
          {FORMAT_OPTIONS.map((f) => (
            <button
              key={f.value}
              type="button"
              className={format === f.value ? "export-format active" : "export-format"}
              onClick={() => setFormat(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="export-dialog-row">
        <label className="export-dialog-field">
          <span className="export-dialog-label">Título</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Título del documento"
          />
        </label>
      </div>

      <div className="export-dialog-row">
        <label className="export-dialog-field">
          <span className="export-dialog-label">Autor</span>
          <input
            type="text"
            value={author}
            onChange={(e) => setAuthor(e.target.value)}
            placeholder="Autor (opcional)"
          />
        </label>
      </div>

      {error && <p className="export-dialog-error">{error}</p>}

      <div className="export-dialog-actions">
        <button type="button" className="export-dialog-secondary" onClick={onCancel}>
          Cerrar
        </button>
        <button type="button" className="export-dialog-primary" onClick={handleExport}>
          Exportar audio
        </button>
      </div>
    </div>
  );
}
