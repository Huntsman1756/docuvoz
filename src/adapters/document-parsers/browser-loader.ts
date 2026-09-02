/**
 * Browser PDF extraction using pdf.js. Runs entirely client-side: the PDF
 * bytes never leave the browser (see docs/privacy.md).
 *
 * The worker is copied to /public/pdfjs by `npm run setup:pdfjs` (wired into
 * predev/prebuild) so the setup is reproducible and framework-agnostic.
 */
import type { StructuredDocument } from "@/domain/documents/types";
import { buildDocument, type RawPdfItem, type RawPdfPage } from "./build-document";

export async function extractPdf(
  data: ArrayBuffer,
  meta: { id: string; name: string; sha256?: string; language?: string },
): Promise<StructuredDocument> {
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/pdfjs/pdf.worker.min.mjs";
  const pdf = await pdfjs.getDocument({
    data,
    standardFontDataUrl: "/pdfjs/standard_fonts/",
  }).promise;
  const pages: RawPdfPage[] = [];
  try {
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const view = page.view;
      const items: RawPdfItem[] = [];
      for (const item of content.items) {
        if (!("str" in item) || item.str.trim() === "") continue;
        const t = item.transform;
        const height = item.height > 0 ? item.height : Math.abs(t[3]);
        items.push({
          str: item.str,
          x: t[4],
          yTop: view[3] - t[5],
          width: item.width,
          height,
        });
      }
      pages.push({
        page: pageNumber,
        width: view[2] - view[0],
        height: view[3] - view[1],
        items,
      });
    }
  } finally {
    await pdf.loadingTask.destroy();
  }
  return buildDocument(pages, meta);
}

export async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
