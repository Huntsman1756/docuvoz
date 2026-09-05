/**
 * Client-side ingestion guards (server has its own independent validation).
 *
 * Supports all document formats: PDF, EPUB, DOCX, TXT, Markdown, HTML.
 */

export const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024; // 50 MB

/** Supported file extensions for validation. */
const SUPPORTED_EXTENSIONS =
  /\.(pdf|epub|docx|txt|text|md|markdown|mdown|mkd|html|htm)$/i;

/** MIME types accepted for document upload. */
const SUPPORTED_MIMES = new Set([
  "application/pdf",
  "application/epub+zip",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "text/plain",
  "text/markdown",
  "text/x-markdown",
  "text/html",
  "",
]);

export function validateDocumentFile(file: File): string | null {
  if (file.size === 0) return "empty_file";
  if (file.size > MAX_DOCUMENT_BYTES) return "file_too_large";
  if (!SUPPORTED_EXTENSIONS.test(file.name)) return "unsupported_type";
  if (!SUPPORTED_MIMES.has(file.type)) return "unsupported_type";
  return null;
}

/**
 * @deprecated Use validateDocumentFile instead.
 * Kept for backward compatibility during migration.
 */
export const validatePdfFile = validateDocumentFile;

/**
 * @deprecated Use validateDocumentFile instead.
 * Kept for backward compatibility during migration.
 */
export const MAX_PDF_BYTES = MAX_DOCUMENT_BYTES;

/** PDF magic-number check on the first bytes. */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  const head = "%PDF-";
  for (let i = 0; i < head.length; i++) {
    if (String.fromCharCode(bytes[i] ?? 0) !== head[i]) return false;
  }
  return true;
}

/** ZIP magic-number check (PK\\x03\\x04). */
export function hasZipMagic(bytes: Uint8Array): boolean {
  return bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}
