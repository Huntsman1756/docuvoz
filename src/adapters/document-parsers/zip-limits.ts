/**
 * Adapter-level resource-exhaustion limits for ZIP containers (EPUB/DOCX).
 *
 * JSZip's `loadAsync` only parses the central directory — entry inflation is
 * lazy — so per-entry uncompressed sizes are available BEFORE any content is
 * decompressed. We enforce cheap metadata-based ceilings here, at the adapter
 * boundary, instead of inventing archive handling inside the parsers.
 *
 * Rationale for the numbers (2026-09):
 *  - `maxEntries` 10 000: very large EPUBs (manga/comics) ship a few thousand
 *    image entries; a huge text book is well under 1 000. Ten thousand keeps
 *    every legitimate book and rejects entry-count bombs early.
 *  - `maxEntryUncompressedBytes` 64 MiB: a single XHTML chapter above 64 MB of
 *    text is pathological (normal chapters are < 1 MB); a single embedded
 *    image/video above 64 MB exceeds what the 50 MB upload cap makes
 *    sensible. Anything larger is either a bomb or a broken archive.
 *  - `maxTotalUncompressedBytes` 256 MiB: a legitimate 50 MB EPUB is mostly
 *    already-compressed media (uncompressed ≈ compressed), so its total
 *    expansion is near 50 MB. Reaching 256 MB requires ≥5:1 global
 *    compression, i.e. a zip-bomb shape. 256 MB also bounds inflated text
 *    pressure on the renderer.
 *
 * These are deliberately generous: normal documents must never trip them.
 * They exist to fail *fast* on adversarial archives, before inflation.
 */

import type JSZip from "jszip";

export const ZIP_LIMITS = {
  maxEntries: 10_000,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
} as const;

export interface ZipLimits {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
}

/**
 * Uncompressed size of a JSZip entry from the central directory.
 * JSZip exposes this only via its internal `_data` (no public accessor);
 * unknown sizes return -1 and are skipped by the size checks (entry-count
 * and stream-time behavior still bound them).
 */
export function entryUncompressedSize(entry: unknown): number {
  const data = (entry as { _data?: { uncompressedSize?: number } })?._data;
  const size = data?.uncompressedSize;
  return typeof size === "number" && size >= 0 ? size : -1;
}

/**
 * Validate an already-parsed archive's metadata against the limits.
 * Throws user-facing Spanish errors (the Reader shows them verbatim).
 */
export function enforceZipLimits(
  zip: JSZip,
  limits: ZipLimits = ZIP_LIMITS,
  label = "archivo",
): void {
  const entries = Object.values(zip.files) as unknown as Array<{
    name: string;
    dir: boolean;
    _data?: { uncompressedSize?: number };
  }>;

  if (entries.length > limits.maxEntries) {
    throw new Error(
      `El ${label} contiene demasiados elementos (${entries.length}). ` +
        `El máximo admitido es ${limits.maxEntries}.`,
    );
  }

  let total = 0;
  for (const entry of entries) {
    if (entry.dir) continue;
    const size = entryUncompressedSize(entry);
    if (size < 0) continue;
    if (size > limits.maxEntryUncompressedBytes) {
      throw new Error(
        `Un elemento del ${label} se descomprime en ${(size / 1024 / 1024).toFixed(0)} MB, ` +
          `por encima del máximo seguro de ${(limits.maxEntryUncompressedBytes / 1024 / 1024).toFixed(0)} MB. ` +
          "El archivo parece manipulado o dañado.",
      );
    }
    total += size;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new Error(
        `El contenido del ${label} se descomprime en más de ` +
          `${(limits.maxTotalUncompressedBytes / 1024 / 1024).toFixed(0)} MB. ` +
          "El archivo parece manipulado o dañado.",
      );
    }
  }
}
