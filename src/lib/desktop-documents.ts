/**
 * Desktop document access — native dialog + Rust-backed read.
 *
 * Desktop flow (§5 of the v0.2 contract):
 *   Open        → native system file dialog (tauri-plugin-dialog, invoked
 *                 through our own command) → filesystem PATH
 *   Read        → Rust validates (exists / is-file / ≤50 MB) and returns raw
 *                 bytes over the IPC (same raw-response channel as audio)
 *   Reopen      → stored safe local path → read → fingerprint verified
 *                 client-side before any position restore
 *   Missing     → structured error → UI clears the stale path and offers the
 *                 native "Locate file" action, again fingerprint-verified
 *
 * The browser never touches the path beyond passing it back to Rust; the
 * WebView has no arbitrary filesystem access. Web builds never call any of
 * this (gated on `isDesktop()` at the call sites).
 */
import { computeContentFingerprint } from "./recent-documents";
import { desktopInvoke, isDesktop } from "./desktop-bridge";

export interface DesktopDocument {
  file: File;
  /** Absolute filesystem path (desktop-local reference, safe to persist). */
  path: string;
}

/** Stable error codes mirrored from src-tauri/src/desktop.rs. */
export type DesktopFileError =
  | "invalid_path"
  | "file_missing"
  | "file_not_a_file"
  | "empty_file"
  | "file_too_large"
  | "file_unreadable";

const EXT_TO_MIME: Record<string, string> = {
  pdf: "application/pdf",
  epub: "application/epub+zip",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  text: "text/plain",
  md: "text/markdown",
  markdown: "text/markdown",
  mdown: "text/markdown",
  mkd: "text/markdown",
  html: "text/html",
  htm: "text/html",
};

function fileNameFromPath(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? "documento";
  return base;
}

function bytesToFile(bytes: ArrayBuffer, path: string): File {
  const name = fileNameFromPath(path);
  const ext = /\.([^.]+)$/.exec(name)?.[1]?.toLowerCase() ?? "";
  return new File([bytes], name, { type: EXT_TO_MIME[ext] ?? "" });
}

/** Read + validate one document by path. Throws `DesktopFileError` codes. */
export async function readDesktopDocument(path: string): Promise<DesktopDocument> {
  if (!isDesktop()) throw new Error("not_desktop");
  const bytes = await desktopInvoke<ArrayBuffer>("desktop_read_document", { path });
  return { file: bytesToFile(bytes, path), path };
}

/**
 * Native open dialog. Returns null when the user cancels.
 * `defaultDir` pre-seeds the dialog directory (used by "Ubicar archivo").
 */
export async function pickDesktopDocument(
  defaultDir?: string,
): Promise<DesktopDocument | null> {
  if (!isDesktop()) return null;
  const path = await desktopInvoke<string | null>("desktop_pick_document", {
    defaultDir: defaultDir ?? null,
  });
  if (!path) return null;
  const doc = await readDesktopDocument(path);
  return doc;
}

/** Native "Locate file" dialog, pre-seeded at the missing file's directory. */
export async function locateDesktopDocument(
  missingPath: string,
): Promise<DesktopDocument | null> {
  if (!isDesktop()) return null;
  const path = await desktopInvoke<string | null>("desktop_locate_document", {
    missingPath,
  });
  if (!path) return null;
  const doc = await readDesktopDocument(path);
  return doc;
}

/**
 * Read a document and verify it is still the document the recent entry
 * refers to. Returns null when the file is gone/unreadable, and
 * `mismatch: true` when a readable file has different content (never
 * silently restored).
 */
export async function reopenDesktopDocument(
  path: string,
  expectedFingerprint: string,
): Promise<
  | { ok: true; doc: DesktopDocument }
  | { ok: false; reason: DesktopFileError }
  | { ok: false; mismatch: true; doc: DesktopDocument }
> {
  let doc: DesktopDocument;
  try {
    doc = await readDesktopDocument(path);
  } catch (error) {
    return { ok: false, reason: (error as Error).message as DesktopFileError };
  }
  const fingerprint = await computeContentFingerprint(doc.file);
  if (fingerprint !== expectedFingerprint) {
    return { ok: false, mismatch: true, doc };
  }
  return { ok: true, doc };
}

/** Directory part of a desktop path (for pre-seeding dialogs). */
export function desktopDirOf(path: string): string {
  const idx = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return idx > 0 ? path.slice(0, idx) : "";
}
