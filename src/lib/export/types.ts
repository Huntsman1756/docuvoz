/**
 * Document → audiobook export types.
 *
 * Provider-independent model shared by all export formats.
 */

/** Supported output formats. */
export type ExportFormat = "wav" | "mp3" | "m4a";

/** Metadata embedded in the output file. */
export interface ExportMetadata {
  title?: string;
  author?: string;
}

/** Progress callback payload. */
export interface ExportProgress {
  done: number;
  total: number;
}

/** Options for the export function. */
export interface ExportOptions {
  format: ExportFormat;
  metadata?: ExportMetadata;
  signal?: AbortSignal;
  onProgress?: (p: ExportProgress) => void;
}

/** A chapter derived from document structure. */
export interface AudioChapter {
  title: string;
  startChunkIndex: number;
  /** Estimated start time in seconds (filled during encoding). */
  startTime: number;
}

/** File extension for a given format. */
export const FORMAT_EXT: Record<ExportFormat, string> = {
  wav: ".wav",
  mp3: ".mp3",
  m4a: ".m4a",
};

/** MIME type for a given format. */
export const FORMAT_MIME: Record<ExportFormat, string> = {
  wav: "audio/wav",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
};
