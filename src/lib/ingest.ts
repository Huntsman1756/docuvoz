/** Client-side ingestion guards (server has its own independent validation). */

export const MAX_PDF_BYTES = 25 * 1024 * 1024;

export function validatePdfFile(file: File): string | null {
  if (file.size === 0) return "empty_file";
  if (file.size > MAX_PDF_BYTES) return "file_too_large";
  const isPdfName = /\.pdf$/i.test(file.name);
  const isPdfMime = file.type === "application/pdf" || file.type === "";
  if (!isPdfName || !isPdfMime) return "unsupported_type";
  return null;
}

/** PDF magic-number check on the first bytes. */
export function hasPdfMagic(bytes: Uint8Array): boolean {
  const head = "%PDF-";
  for (let i = 0; i < head.length; i++) {
    if (String.fromCharCode(bytes[i] ?? 0) !== head[i]) return false;
  }
  return true;
}
