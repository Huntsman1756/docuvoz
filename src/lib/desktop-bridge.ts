/**
 * Minimal typed access to the Tauri bridge for desktop-only facilities.
 *
 * The desktop WebView never receives shell/process capabilities, the sidecar
 * port/token, or provider secrets — every command it may call is defined in
 * `src-tauri/src/main.rs` (speech proxy) or `src-tauri/src/desktop.rs` (files,
 * app-data state, keyring).
 */
import { isDesktopRuntime } from "./speech-transport";

export function isDesktop(): boolean {
  return isDesktopRuntime();
}

export function desktopInvoke<T>(
  cmd: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const tauri = (
    window as {
      __TAURI__?: {
        core: { invoke: <R>(c: string, a?: Record<string, unknown>) => Promise<R> };
      };
    }
  ).__TAURI__;
  if (!tauri) {
    return Promise.reject(new Error("desktop_bridge_unavailable"));
  }
  return tauri.core.invoke<T>(cmd, args);
}
