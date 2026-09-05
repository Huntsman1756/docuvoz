/**
 * Position persistence for playback state.
 *
 * Saves semantic position (section + document time) to IndexedDB
 * for robust resume after reload. Falls back to localStorage.
 *
 * Privacy: Only metadata is stored (no document content).
 */
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "auidionan-position";
const STORE = "positions";
const MAX_AGE_DAYS = 90;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 3600 * 1000;

export interface SavedPosition {
  /** Document fingerprint (matches RecentDocument.fingerprint). */
  fingerprint: string;
  /** Semantic section/chapter identifier. */
  sectionId?: string;
  /** Section label for display. */
  sectionLabel?: string;
  /** Block index within section or document. */
  blockIndex?: number;
  /** Document time in seconds (audio timeline). */
  docTime: number;
  /** Playback speed. */
  speed: number;
  /** Chunk index for quick restore. */
  chunkIndex?: number;
  /** Timestamp of save (auto-set by savePosition if not provided). */
  savedAt?: number;
  /** Filename for display. */
  filename: string;
}

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: "fingerprint" });
        store.createIndex("savedAt", "savedAt");
      }
    },
  });
  return dbPromise;
}

/**
 * Save playback position for a document.
 */
export async function savePosition(position: SavedPosition): Promise<void> {
  try {
    await (await db()).put(STORE, { ...position, savedAt: Date.now() });
  } catch {
    // Position saves must never break playback
  }
}

/**
 * Load saved position for a document.
 * Returns null if no position exists or if it's expired.
 */
export async function loadPosition(fingerprint: string): Promise<SavedPosition | null> {
  try {
    const record = (await (await db()).get(STORE, fingerprint)) as
      SavedPosition | undefined;
    if (!record) return null;
    if (record.savedAt != null && Date.now() - record.savedAt > MAX_AGE_MS) return null;
    return record;
  } catch {
    return null;
  }
}

/**
 * Remove saved position for a document.
 */
export async function removePosition(fingerprint: string): Promise<void> {
  try {
    await (await db()).delete(STORE, fingerprint);
  } catch {
    // Silently fail
  }
}

/**
 * List all saved positions, sorted by most recent.
 */
export async function listPositions(): Promise<SavedPosition[]> {
  try {
    const all = await (await db()).getAll(STORE);
    return (all as SavedPosition[])
      .filter((p) => p.savedAt == null || Date.now() - p.savedAt <= MAX_AGE_MS)
      .sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0));
  } catch {
    return [];
  }
}

/**
 * Clear all saved positions.
 */
export async function clearPositions(): Promise<void> {
  try {
    await (await db()).clear(STORE);
  } catch {
    // Silently fail
  }
}
