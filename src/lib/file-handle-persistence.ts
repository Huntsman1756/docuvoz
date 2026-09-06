/**
 * Persistent file reopen via the File System Access API.
 *
 * On Chromium, when the user picks a document through the browser-native
 * file picker (`showOpenFilePicker`), we may retain the resulting
 * `FileSystemFileHandle` in IndexedDB, keyed by the document content
 * fingerprint. On a later "Reanudar" the handle is queried for read
 * permission (and re-requested on an explicit user gesture) so the file can
 * be reopened directly without reselecting it.
 *
 * Never mandatory: if the API is unavailable, permission is denied, the file
 * is stale/deleted, or the handle is lost, the caller falls back to the
 * existing file-reselection + content-fingerprint workflow.
 *
 * Privacy: only an opaque handle is persisted locally; document contents are
 * never copied or uploaded.
 */
import { openDB, type IDBPDatabase } from "idb";

const DB_NAME = "auidionan-handles";
const STORE = "handles";

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE)) {
        database.createObjectStore(STORE, { keyPath: "fingerprint" });
      }
    },
  });
  return dbPromise;
}

/** Whether the File System Access API is available in this browser. */
export function supportsFileSystemAccess(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.showOpenFilePicker === "function" &&
    typeof window.FileSystemFileHandle !== "undefined"
  );
}

/** Persist a handle keyed by content fingerprint (best-effort, never throws). */
export async function storeFileHandle(
  fingerprint: string,
  handle: FileSystemFileHandle,
): Promise<void> {
  try {
    await (await db()).put(STORE, { fingerprint, handle });
  } catch {
    // Persisting a handle is best-effort; never break the open flow.
  }
}

/** Retrieve a stored handle for a fingerprint, or null if absent. */
export async function getFileHandle(
  fingerprint: string,
): Promise<FileSystemFileHandle | null> {
  try {
    const rec = (await (await db()).get(STORE, fingerprint)) as
      { fingerprint: string; handle: FileSystemFileHandle } | undefined;
    return rec?.handle ?? null;
  } catch {
    return null;
  }
}

/** Remove a stored handle (e.g. when a document is evicted). */
export async function removeFileHandle(fingerprint: string): Promise<void> {
  try {
    await (await db()).delete(STORE, fingerprint);
  } catch {
    // Ignore.
  }
}

/**
 * Ensure read permission for a handle. Re-requests through the browser
 * permission prompt only when the caller has a user gesture. Returns true
 * only when the handle is actually readable.
 */
export async function ensureReadPermission(
  handle: FileSystemFileHandle,
): Promise<boolean> {
  try {
    const opts = { mode: "read" } as const;
    let perm = await handle.queryPermission(opts);
    if (perm === "prompt") {
      perm = await handle.requestPermission(opts);
    }
    return perm === "granted";
  } catch {
    return false;
  }
}
