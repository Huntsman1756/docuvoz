/**
 * PDF document adapter wrapping the existing extraction pipeline.
 *
 * Delegates to the existing browser-loader.ts + build-document.ts
 * which are already format-specific and well-tested.
 */
import type { DocumentAdapter, LoadOptions } from "../document-adapter";
import type { StructuredDocument } from "@/domain/documents/types";

const ADAPTER_ID = "pdfjs-browser";

export const pdfAdapter: DocumentAdapter = {
  id: ADAPTER_ID,
  formats: ["pdf"],
  mimeTypes: ["application/pdf"],
  extensions: [".pdf"],

  canOpen(file: File): boolean {
    const name = file.name.toLowerCase();
    return name.endsWith(".pdf") || file.type === "application/pdf";
  },

  async load(
    file: File,
    options: LoadOptions,
    signal?: AbortSignal,
  ): Promise<StructuredDocument> {
    const { extractPdf, sha256Hex } = await import("../browser-loader");

    const buffer = await file.arrayBuffer();
    if (signal?.aborted) throw new DOMException("Cancelled", "AbortError");

    // Compute hash if not provided
    const sha256 = options.sha256 ?? (await sha256Hex(buffer));

    return extractPdf(buffer, {
      id: options.id,
      name: options.name ?? file.name,
      sha256,
      language: options.language ?? "es",
    });
  },
};
