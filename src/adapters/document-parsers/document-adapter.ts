/**
 * Document adapter interface and registry.
 *
 * Each format adapter produces a canonical StructuredDocument from raw file
 * bytes. The Reader delegates to the registry for format detection and
 * adapter selection — no if/else chains for file types.
 */
import type { StructuredDocument } from "@/domain/documents/types";

export type DocumentFormat = "pdf" | "epub" | "docx" | "txt" | "markdown" | "html";

export interface DocumentAdapter {
  /** Unique adapter identifier (e.g. "pdfjs-browser", "foliate-epub"). */
  readonly id: string;
  /** Formats this adapter handles. */
  readonly formats: DocumentFormat[];
  /** Supported MIME types for detection. */
  readonly mimeTypes: string[];
  /** Supported file extensions (with dot, e.g. ".pdf"). */
  readonly extensions: string[];
  /** Whether the file can be opened by this adapter (quick check). */
  canOpen(file: File): boolean;
  /** Load and parse the file into a StructuredDocument. */
  load(
    file: File,
    options: LoadOptions,
    signal?: AbortSignal,
  ): Promise<StructuredDocument>;
}

export interface LoadOptions {
  /** Document id prefix (derived from content hash when available). */
  id: string;
  /** Original filename. */
  name: string;
  /** SHA-256 hex of original bytes. */
  sha256?: string;
  /** Preferred language override. */
  language?: string;
}

/**
 * Detect the document format from file metadata and magic bytes.
 * Returns null if the format cannot be determined.
 */
export async function detectFormat(
  file: File,
  headBytes?: Uint8Array,
): Promise<DocumentFormat | null> {
  const ext = file.name.toLowerCase();
  const mime = file.type;

  // Check by extension first (most reliable for user-uploaded files)
  if (ext.endsWith(".pdf")) return "pdf";
  if (ext.endsWith(".epub")) return "epub";
  if (ext.endsWith(".docx")) return "docx";
  if (ext.endsWith(".txt") || ext.endsWith(".text")) return "txt";
  if (
    ext.endsWith(".md") ||
    ext.endsWith(".markdown") ||
    ext.endsWith(".mdown") ||
    ext.endsWith(".mkd")
  )
    return "markdown";
  if (ext.endsWith(".html") || ext.endsWith(".htm")) return "html";

  // Check by MIME type
  if (mime === "application/pdf") return "pdf";
  if (mime === "application/epub+zip") return "epub";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document")
    return "docx";
  if (mime === "text/plain") return "txt";
  if (mime === "text/markdown") return "markdown";
  if (mime === "text/html") return "html";

  // Magic bytes detection
  if (headBytes && headBytes.length >= 4) {
    // PDF: %PDF-
    if (
      headBytes[0] === 0x25 &&
      headBytes[1] === 0x50 &&
      headBytes[2] === 0x44 &&
      headBytes[3] === 0x46
    )
      return "pdf";
    // ZIP (EPUB or DOCX): PK\x03\x04
    if (
      headBytes[0] === 0x50 &&
      headBytes[1] === 0x4b &&
      headBytes[2] === 0x03 &&
      headBytes[3] === 0x04
    ) {
      // ZIP container — could be EPUB or DOCX; without deeper inspection, prefer extension
      return null;
    }
  }

  return null;
}

/** Adapter registry: format → adapter mapping. */
const adapters = new Map<DocumentFormat, DocumentAdapter>();

export function registerAdapter(adapter: DocumentAdapter): void {
  for (const format of adapter.formats) {
    adapters.set(format, adapter);
  }
}

export function getAdapter(format: DocumentFormat): DocumentAdapter | undefined {
  return adapters.get(format);
}

export function getAdapters(): DocumentAdapter[] {
  return [...adapters.values()];
}
