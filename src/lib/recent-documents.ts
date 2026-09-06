/**
 * Recent documents persistence (local only, no cloud).
 *
 * Stores document metadata and playback position in localStorage
 * for quick resume. Maximum 5 recent documents.
 *
 * Privacy: Only metadata is stored (no document content).
 * The file must be reopened by the user for security.
 *
 * Fingerprint identity:
 * - Primary: SHA-256 of file bytes (first 16 hex chars = 64 bits)
 * - Content-based: same file content → same fingerprint regardless of filename
 * - No fallback for missing hash: documents without SHA-256 cannot be resumed
 */
import type { StructuredDocument } from "@/domain/documents/types";
import { desktopStateGet, desktopStateSet } from "./desktop-app-state";
import { isDesktop } from "./desktop-bridge";

const STORAGE_KEY = "auidionan-recent";
const MAX_RECENT = 5;

export interface RecentDocument {
  /** Document fingerprint: SHA-256 prefix of file content (64 bits). */
  fingerprint: string;
  /** Original filename (display only, not used for identity). */
  filename: string;
  /** Document title (if available). */
  title?: string;
  /** Author (if available). */
  author?: string;
  /** Document type/extension. */
  docType: string;
  /** Last listened section/chapter label. */
  lastSection?: string;
  /** Last canonical source position (section/block index). */
  lastPosition?: number;
  /** Last document-time position (seconds). */
  lastDocTime?: number;
  /** Playback speed at last pause. */
  playbackSpeed?: number;
  /** Timestamp of last access. */
  lastOpened: number;
  /** Number of times resumed. */
  resumeCount: number;
  /**
   * Desktop only: safe local path reference for native reopen. The web build
   * never stores paths (it uses browser file handles instead); desktop
   * reopen always verifies the content fingerprint before restoring.
   */
  path?: string;
}

function isRecentDocument(obj: unknown): obj is RecentDocument {
  return (
    typeof obj === "object" &&
    obj !== null &&
    "fingerprint" in obj &&
    "filename" in obj &&
    "lastOpened" in obj
  );
}

/**
 * Compute a content-based fingerprint from raw file bytes.
 * Uses Web Crypto API for deterministic SHA-256.
 * Returns first 16 hex chars (64 bits) — collision-free for personal use.
 */
export async function computeContentFingerprint(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* Storage backend: desktop keeps continuity state in OS app-data (hydrated
 * mirror); the web build keeps localStorage. Same shapes, same semantics. */
function readRecentsRaw(): RecentDocument[] {
  if (isDesktop()) {
    const stored = desktopStateGet("recents");
    return Array.isArray(stored) ? (stored as unknown[]).filter(isRecentDocument) : [];
  }
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isRecentDocument);
  } catch {
    return [];
  }
}

function writeRecentsRaw(recents: RecentDocument[]): void {
  if (isDesktop()) {
    desktopStateSet("recents", recents);
    return;
  }
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(recents));
  } catch {
    // localStorage may be full - try removing oldest
    if (recents.length > 1) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(recents.slice(0, -1)));
      } catch {
        // Give up silently
      }
    }
  }
}

/**
 * Get all recent documents, sorted by last opened time.
 */
export function getRecentDocuments(): RecentDocument[] {
  return readRecentsRaw().sort((a, b) => b.lastOpened - a.lastOpened);
}

/**
 * Add or update a recent document.
 * Requires a content-based fingerprint (SHA-256 prefix).
 */
export function addRecentDocument(
  doc: StructuredDocument,
  fingerprint: string,
  position: Partial<
    Pick<RecentDocument, "lastSection" | "lastPosition" | "lastDocTime" | "playbackSpeed">
  >,
  origin?: { path?: string },
): RecentDocument {
  const recents = getRecentDocuments();

  // Determine doc type from parser name
  let docType = "unknown";
  if (doc.parser.includes("pdf")) docType = "pdf";
  else if (doc.parser.includes("epub")) docType = "epub";
  else if (doc.parser.includes("docx")) docType = "docx";
  else if (doc.parser.includes("markdown")) docType = "markdown";
  else if (doc.parser.includes("html")) docType = "html";
  else if (doc.parser.includes("txt")) docType = "txt";

  // Find existing entry or create new
  const existingIndex = recents.findIndex((r) => r.fingerprint === fingerprint);
  const existing = existingIndex >= 0 ? recents[existingIndex] : null;

  const entry: RecentDocument = {
    fingerprint,
    filename: doc.source.name,
    title: doc.source.name.replace(/\.[^.]+$/, ""),
    author: doc.source.author,
    docType,
    lastSection: position.lastSection ?? existing?.lastSection,
    lastPosition: position.lastPosition ?? existing?.lastPosition,
    lastDocTime: position.lastDocTime ?? existing?.lastDocTime,
    playbackSpeed: position.playbackSpeed ?? existing?.playbackSpeed,
    lastOpened: Date.now(),
    resumeCount: (existing?.resumeCount ?? 0) + 1,
    // Desktop safe path reference (web build never stores paths); carried
    // over unless explicitly replaced.
    path: isDesktop() ? (origin?.path ?? existing?.path) : undefined,
  };

  // Remove if exists, then add to front
  if (existingIndex >= 0) {
    recents.splice(existingIndex, 1);
  }
  recents.unshift(entry);

  // Keep only MAX_RECENT
  writeRecentsRaw(recents.slice(0, MAX_RECENT));

  return entry;
}

/**
 * Update position for an existing recent document.
 */
export function updateRecentPosition(
  fingerprint: string,
  position: Partial<
    Pick<RecentDocument, "lastSection" | "lastPosition" | "lastDocTime" | "playbackSpeed">
  >,
): void {
  const recents = getRecentDocuments();
  const index = recents.findIndex((r) => r.fingerprint === fingerprint);
  if (index < 0) return;

  const entry = recents[index];
  recents[index] = {
    ...entry,
    ...position,
    lastOpened: Date.now(),
  };

  writeRecentsRaw(recents);
}

/**
 * Remove a recent document.
 */
export function removeRecentDocument(fingerprint: string): void {
  const recents = getRecentDocuments();
  const filtered = recents.filter((r) => r.fingerprint !== fingerprint);
  writeRecentsRaw(filtered);
}

/**
 * Desktop only: record the (verified) local path for an existing entry.
 */
export function setRecentPath(fingerprint: string, path: string): void {
  const recents = getRecentDocuments();
  const index = recents.findIndex((r) => r.fingerprint === fingerprint);
  if (index < 0) return;
  recents[index] = { ...recents[index], path, lastOpened: Date.now() };
  writeRecentsRaw(recents);
}

/**
 * Desktop only: clear a stale path reference (file moved/deleted/unreadable)
 * while keeping the position metadata, so the UI can offer "Locate file".
 */
export function clearRecentPath(fingerprint: string): void {
  const recents = getRecentDocuments();
  const index = recents.findIndex((r) => r.fingerprint === fingerprint);
  if (index < 0) return;
  const entry: RecentDocument = {
    ...recents[index],
    path: undefined,
    lastOpened: Date.now(),
  };
  recents[index] = entry;
  writeRecentsRaw(recents);
}

/**
 * Check if a document can be resumed.
 * Returns true if we have a stored position for this fingerprint.
 */
export function canResume(fingerprint: string): boolean {
  const recents = getRecentDocuments();
  return recents.some(
    (r) => r.fingerprint === fingerprint && r.lastDocTime != null && r.lastDocTime > 0,
  );
}

/**
 * Get a recent document by fingerprint.
 */
export function getRecentByFingerprint(fingerprint: string): RecentDocument | undefined {
  return getRecentDocuments().find((r) => r.fingerprint === fingerprint);
}
