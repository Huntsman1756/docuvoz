/**
 * IndexedDB audio cache (client side).
 *
 * Stores provider audio blobs under the server-computed cache key so
 * replays, seek-back and reloads never hit the network. Entries are
 * immutable content-hash keys; invalidation happens by changing the key
 * (spoken engine version is part of it).
 *
 * Retention: 30 days. Expired entries are treated as cache misses on read.
 * Background pruning removes expired entries lazily (bounded iteration).
 */
import { openDB, type IDBPDatabase } from "idb";

interface AudioRecord {
  key: string;
  blob: Blob;
  createdAt: number;
}

const DB_NAME = "auidionan-audio";
const STORE = "audio";
const MAX_AGE_DAYS = 30;
const MAX_AGE_MS = MAX_AGE_DAYS * 24 * 3600 * 1000;

let dbPromise: Promise<IDBPDatabase> | null = null;

function db(): Promise<IDBPDatabase> {
  dbPromise ??= openDB(DB_NAME, 1, {
    upgrade(database) {
      if (!database.objectStoreNames.contains(STORE)) {
        const store = database.createObjectStore(STORE, { keyPath: "key" });
        store.createIndex("createdAt", "createdAt");
      }
    },
  });
  return dbPromise;
}

function isExpired(record: AudioRecord): boolean {
  return Date.now() - record.createdAt > MAX_AGE_MS;
}

export async function getCachedAudio(key: string): Promise<Blob | null> {
  try {
    const record = (await (await db()).get(STORE, key)) as AudioRecord | undefined;
    if (!record) return null;
    // Expired entries are treated as cache misses.
    if (isExpired(record)) return null;
    return record.blob;
  } catch {
    return null;
  }
}

export async function putCachedAudio(key: string, blob: Blob): Promise<void> {
  try {
    await (await db()).put(STORE, { key, blob, createdAt: Date.now() });
  } catch {
    /* cache misses must never break playback */
  }
}

/**
 * Remove expired entries. Uses the createdAt index for efficient iteration,
 * stopping early once it encounters non-expired entries (index is sorted).
 * Returns the number of entries removed.
 */
export async function pruneAudioCache(): Promise<number> {
  try {
    const database = await db();
    const cutoff = Date.now() - MAX_AGE_MS;
    const tx = database.transaction(STORE, "readwrite");
    let removed = 0;
    // Bounded iteration: stop after 200 entries to avoid long transactions.
    const MAX_PRUNE_ITERATIONS = 200;
    let iterations = 0;
    for await (const cursor of tx.store.index("createdAt").iterate()) {
      iterations += 1;
      if (iterations > MAX_PRUNE_ITERATIONS) break;
      const value = cursor.value as AudioRecord;
      if (value.createdAt >= cutoff) break; // index is sorted; rest is fresh
      await cursor.delete();
      removed += 1;
    }
    await tx.done;
    return removed;
  } catch {
    return 0;
  }
}
