/**
 * Document adapter registry.
 *
 * Registers all format adapters and provides format detection +
 * adapter selection. Import this module to initialize all adapters.
 */
import {
  type DocumentFormat,
  type DocumentAdapter,
  detectFormat,
  registerAdapter,
  getAdapter,
} from "./document-adapter";
import { pdfAdapter } from "./adapters/pdf-adapter";
import { epubAdapter } from "./adapters/epub-adapter";
import { docxAdapter } from "./adapters/docx-adapter";
import { txtAdapter } from "./adapters/txt-adapter";
import { markdownAdapter } from "./adapters/markdown-adapter";
import { htmlAdapter } from "./adapters/html-adapter";

// Register all adapters
registerAdapter(pdfAdapter);
registerAdapter(epubAdapter);
registerAdapter(docxAdapter);
registerAdapter(txtAdapter);
registerAdapter(markdownAdapter);
registerAdapter(htmlAdapter);

export { detectFormat, getAdapter };
export type { DocumentFormat, DocumentAdapter };

/** All supported file extensions for the file input accept attribute. */
export const SUPPORTED_EXTENSIONS = [
  ".pdf",
  ".epub",
  ".docx",
  ".txt",
  ".text",
  ".md",
  ".markdown",
  ".mdown",
  ".mkd",
  ".html",
  ".htm",
].join(",");

/** Human-readable list of supported formats. */
export const SUPPORTED_FORMATS_LABEL = "PDF · EPUB · DOCX · TXT · Markdown · HTML";

/**
 * Detect format and get the appropriate adapter for a file.
 * Returns null if no adapter can handle the file.
 */
export async function resolveAdapter(
  file: File,
): Promise<{ format: DocumentFormat; adapter: DocumentAdapter } | null> {
  // Read first 4 bytes for magic number detection
  const headBytes = new Uint8Array(await file.slice(0, 4).arrayBuffer());

  const format = await detectFormat(file, headBytes);
  if (!format) return null;

  const adapter = getAdapter(format);
  if (!adapter) return null;

  return { format, adapter };
}
