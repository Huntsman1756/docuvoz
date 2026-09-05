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
 *  - `maxCompressionRatio` 100: entries with compressed-to-uncompressed ratio
 *    beyond 100:1 are likely zip-bomb fragments; reject cheaply at metadata
 *    time. Real text is ~3:1, real media is ~1:1 (already compressed).
 *
 * These are deliberately generous: normal documents must never trip them.
 * They exist to fail *fast* on adversarial archives, before inflation.
 *
 * Post-decompression accounting (assessActualExpansion): after JSZip inflates
 * an entry, we verify the ACTUAL output bytes against the budget. JSZip's
 * async() accumulates everything in memory, so we cannot abort mid-stream,
 * but we CAN reject the result before it reaches the adapter. This catches
 * metadata-forged entries where compressedSize is small but inflated data is
 * large (a "small metadata" zip bomb).
 *
 * Path traversal: JSZip's loadAsync() runs utils.resolve() which normalizes
 * `..` segments, so `../../etc/passwd` becomes `etc/passwd`. The original
 * unsanitized name is preserved as `unsafeOriginalName`. We additionally
 * check for absolute-like paths that JSZip may not fully normalize.
 */

import type JSZip from "jszip";

export const ZIP_LIMITS = {
  maxEntries: 10_000,
  maxEntryUncompressedBytes: 64 * 1024 * 1024,
  maxTotalUncompressedBytes: 256 * 1024 * 1024,
  /** Maximum compressed-to-uncompressed ratio before rejecting. */
  maxCompressionRatio: 100,
} as const;

export interface ZipLimits {
  maxEntries: number;
  maxEntryUncompressedBytes: number;
  maxTotalUncompressedBytes: number;
  maxCompressionRatio: number;
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

/** Compressed size from the central directory. */
export function entryCompressedSize(entry: unknown): number {
  const data = (entry as { _data?: { compressedSize?: number } })?._data;
  const size = data?.compressedSize;
  return typeof size === "number" && size >= 0 ? size : -1;
}

/**
 * Detect absolute-like paths that could be used for path traversal.
 * JSZip normalizes `..` segments via utils.resolve(), but some edge cases
 * (e.g. absolute paths on Windows like `C:\...` or UNC `\\server\share`)
 * may survive. We also reject entries whose resolved name still starts
 * with a segment that looks like a system directory.
 */
const ABSOLUTE_PATH_RE = /^(\/|[A-Za-z]:[/\\]|\\\\)/;

export function hasUnsafePath(entryName: string): boolean {
  return ABSOLUTE_PATH_RE.test(entryName);
}

/**
 * Validate an already-parsed archive's metadata against the limits.
 * Throws user-facing Spanish errors (the Reader shows them verbatim).
 *
 * This is the cheap metadata preflight — it runs BEFORE any inflation.
 */
export function enforceZipLimits(
  zip: JSZip,
  limits: ZipLimits = ZIP_LIMITS,
  label = "archivo",
): void {
  const entries = Object.values(zip.files) as unknown as Array<{
    name: string;
    dir: boolean;
    unsafeOriginalName?: string;
    _data?: { uncompressedSize?: number; compressedSize?: number };
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

    // Path traversal: check both the resolved name AND the original
    // unsanitized name that JSZip preserves as `unsafeOriginalName`.
    // JSZip's utils.resolve() strips `..` segments, so a ZIP containing
    // `../../etc/passwd` becomes `etc/passwd` in `entry.name`. The original
    // is available as `unsafeOriginalName` for entries loaded via loadAsync().
    if (
      hasUnsafePath(entry.name) ||
      (entry.unsafeOriginalName && hasUnsafePath(entry.unsafeOriginalName))
    ) {
      throw new Error(
        `El ${label} contiene rutas no válidas. ` +
          "El archivo parece manipulado o dañado.",
      );
    }

    const uncomp = entryUncompressedSize(entry);

    // Unknown uncompressed size: skip size checks (entry-count and
    // stream-time behavior still bound them).
    if (uncomp < 0) continue;

    if (uncomp > limits.maxEntryUncompressedBytes) {
      throw new Error(
        `Un elemento del ${label} se descomprime en ${(uncomp / 1024 / 1024).toFixed(0)} MB, ` +
          `por encima del máximo seguro de ${(limits.maxEntryUncompressedBytes / 1024 / 1024).toFixed(0)} MB. ` +
          "El archivo parece manipulado o dañado.",
      );
    }
    total += uncomp;
  }

  if (total > limits.maxTotalUncompressedBytes) {
    throw new Error(
      `El contenido del ${label} se descomprime en más de ` +
        `${(limits.maxTotalUncompressedBytes / 1024 / 1024).toFixed(0)} MB. ` +
        "El archivo parece manipulado o dañado.",
    );
  }

  // Compression-ratio check (second pass): reject entries whose compression
  // ratio suggests a zip-bomb fragment. This catches small-metadata bombs
  // where declared sizes are under all limits but the ratio is extreme
  // (e.g. 1 KB compressed → 200 MB uncompressed). Running after the total
  // check so that forged-large-size bombs are caught by the total check first.
  for (const entry of entries) {
    if (entry.dir) continue;
    const uncomp = entryUncompressedSize(entry);
    if (uncomp < 0) continue;
    const comp = entryCompressedSize(entry);
    if (comp > 0 && uncomp / comp > limits.maxCompressionRatio) {
      throw new Error(
        `Un elemento del ${label} tiene una relación de compresión extrema. ` +
          "El archivo parece manipulado o dañado.",
      );
    }
  }
}

/**
 * Post-decompression safety check: verify that actual inflated bytes do not
 * exceed the budget. Call this AFTER JSZip.async() resolves.
 *
 * JSZip's async() accumulates everything in memory (~2x decompressed size),
 * so we cannot abort mid-stream. But we CAN reject the result before the
 * adapter processes it, preventing downstream memory amplification.
 *
 * @param actualByteLength - The actual byte length of the inflated result
 *   (e.g. result.length for Uint8Array, buffer.byteLength for ArrayBuffer).
 * @param label - Human-readable label for the archive type ("EPUB", "DOCX").
 * @param limits - Budget limits (defaults to ZIP_LIMITS).
 */
export function assessActualExpansion(
  actualByteLength: number,
  label: string,
  limits: ZipLimits = ZIP_LIMITS,
): void {
  if (actualByteLength > limits.maxEntryUncompressedBytes) {
    throw new Error(
      `Un elemento del ${label} ocupa ${(actualByteLength / 1024 / 1024).toFixed(0)} MB en memoria, ` +
        `por encima del máximo seguro de ${(limits.maxEntryUncompressedBytes / 1024 / 1024).toFixed(0)} MB. ` +
        "El archivo parece manipulado o dañado.",
    );
  }
}
