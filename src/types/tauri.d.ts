/**
 * Minimal ambient declarations for the Tauri v2 WebView bridge.
 *
 * The desktop frontend calls only `window.__TAURI__.core.invoke`. The presence
 * of `window.__TAURI_INTERNALS__` is the runtime marker that the app is running
 * inside Tauri (vs. plain browser/Next). No provider secret, sidecar port, or
 * sidecar token is ever exposed to the frontend — those live in Rust and are
 * proxied by the bridge commands.
 */

interface TauriInvokeFn {
  <T>(cmd: string, args?: Record<string, unknown>): Promise<T>;
}

interface TauriCore {
  invoke: TauriInvokeFn;
}

interface Window {
  __TAURI__?: { core: TauriCore };
  __TAURI_INTERNALS__?: unknown;
}
