/**
 * Desktop continuity state — app-data mirror.
 *
 * Desktop continuity state (recent documents, resume positions, desktop
 * settings) must live in OS app-data (Tauri store), not in localStorage or
 * IndexedDB: those belong to the Web build and do not survive the desktop
 * app's lifecycle cleanly (per-origin WebView storage is opaque and
 * disposable).
 *
 * The shared persistence modules (`recent-documents.ts`,
 * `position-persistence.ts`) keep their synchronous public API. On desktop,
 * they read/write an in-memory mirror hydrated once at startup from
 * `desktop_state_load` (via `desktop/app/layout.tsx`'s gate, which renders
 * the app only after hydration) and flushed back (debounced) through
 * `desktop_state_save`. The Web build never imports these code paths.
 */
import { desktopInvoke, isDesktop } from "./desktop-bridge";

export interface DesktopAppState {
  /** Serialized recent documents (same shape as RecentDocument). */
  recents?: unknown[];
  /** fingerprint -> SavedPosition (same shape as the IndexedDB record). */
  positions?: Record<string, unknown>;
  /** Desktop settings: engine/voice/rate preferences + non-secret endpoint. */
  settings?: Record<string, unknown>;
}

const SAVE_DEBOUNCE_MS = 250;

let mirror: DesktopAppState = {};
let hydration: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function flush(): void {
  saveTimer = null;
  if (!isDesktop()) return;
  void desktopInvoke("desktop_state_save", { state: mirror }).catch(() => {
    // Continuity persistence is best-effort; never break the app.
  });
}

function scheduleSave(): void {
  if (saveTimer != null) clearTimeout(saveTimer);
  saveTimer = setTimeout(flush, SAVE_DEBOUNCE_MS);
}

/** Load once; resolves after the mirror is populated (or on failure). */
export function hydrateDesktopState(): Promise<void> {
  if (!isDesktop()) return Promise.resolve();
  if (hydration) return hydration;
  hydration = (async () => {
    try {
      const state = await desktopInvoke<DesktopAppState | null>("desktop_state_load");
      mirror = state ?? {};
    } catch {
      mirror = {};
    }
  })();
  return hydration;
}

/** Synchronous read from the hydrated mirror (desktop only). */
export function desktopStateGet<K extends keyof DesktopAppState>(
  key: K,
): DesktopAppState[K] {
  return mirror[key];
}

/** Write-through with debounced flush to app-data. */
export function desktopStateSet<K extends keyof DesktopAppState>(
  key: K,
  value: DesktopAppState[K],
): void {
  mirror[key] = value;
  scheduleSave();
}

/** Await-able flush for tests and shutdown paths. */
export async function flushDesktopState(): Promise<void> {
  if (!isDesktop()) return;
  if (saveTimer != null) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await desktopInvoke("desktop_state_save", { state: mirror }).catch(() => undefined);
}
