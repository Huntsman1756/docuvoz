/**
 * DocuVoz desktop — native file access, app-data state, and secrets.
 *
 * All desktop facilities live behind tiny Tauri commands invoked through the
 * same proven pathway as the speech bridge (`window.__TAURI__.core.invoke`).
 * The WebView never sees: the sidecar token, the sidecar port, any provider
 * API key, or raw shell/process capabilities.
 *
 * File model:
 *   - `desktop_pick_document` / `desktop_locate_document` use the official
 *     Tauri dialog (native file picker per OS); they return a filesystem PATH.
 *   - `desktop_read_document` reads and validates the file in Rust and returns
 *     raw bytes as a `tauri::ipc::Response` (same mechanism as the audio
 *     frame; no base64, no JSON-array serialization for multi-MB files).
 *   - The WebView computes the content fingerprint client-side (same SHA-256
 *     code as the Web build) and verifies it before restoring position, so a
 *     moved/edited file can never be silently restored as another document.
 *
 * Continuity state (recents, resume positions, desktop settings) lives in
 * app-data via the official tauri-plugin-store — NOT in localStorage/IndexedDB
 * (which belong to the Web build only).
 *
 * Secret (NAN_API_KEY) lives in the OS credential store via the `keyring`
 * crate (Windows Credential Manager / macOS Keychain). Decision: native OS
 * keyring over Stronghold — no extra vault password for the user to manage,
 * no new file format, smallest reliable Windows + macOS surface. The secret
 * is never returned to the WebView (only a `configured` boolean) and is never
 * logged; Rust injects it into the sidecar's environment at spawn time.
 */
use serde_json::Value;
use tauri::AppHandle;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_store::StoreExt;

/// Product limit (matches the web build's `MAX_DOCUMENT_BYTES`).
const MAX_DOCUMENT_BYTES: u64 = 50 * 1024 * 1024;
const KEYRING_SERVICE: &str = "DocuVoz";
const KEYRING_USER: &str = "nan_api_key";

/* ── Secret (NAN_API_KEY) — OS keyring ──────────────────────────────────── */

/// Read the stored NaN API key, if any. Never log the value.
pub fn nan_api_key() -> Option<String> {
    let entry = keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).ok()?;
    match entry.get_password() {
        Ok(v) if !v.is_empty() => Some(v),
        _ => None,
    }
}

/// Read the non-secret NaN endpoint from the desktop settings store.
pub fn nan_base_url(app: &AppHandle) -> Option<String> {
    let store = app.store("desktop-state.json").ok()?;
    let state = store.get("state")?;
    let url = state
        .get("settings")?
        .get("nanBaseUrl")?
        .as_str()?
        .trim()
        .to_string();
    if url.is_empty() { None } else { Some(url) }
}

pub fn nan_key_set(key: String) -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    entry.set_password(&key).map_err(|e| e.to_string())
}

pub fn nan_key_clear() -> Result<(), String> {
    let entry =
        keyring::Entry::new(KEYRING_SERVICE, KEYRING_USER).map_err(|e| e.to_string())?;
    // Deleting a non-existent secret is not an error for the user's purpose.
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn desktop_nan_key_configured() -> bool {
    nan_api_key().is_some()
}

#[tauri::command]
pub fn desktop_set_nan_key(key: String) -> Result<(), String> {
    if key.trim().len() < 8 {
        return Err("invalid_key".to_string());
    }
    nan_key_set(key)
}

#[tauri::command]
pub fn desktop_clear_nan_key() -> Result<(), String> {
    nan_key_clear()
}

/* ── App-data continuity state (official tauri-plugin-store) ───────────── */

#[tauri::command]
pub fn desktop_state_load(app: AppHandle) -> Result<Value, String> {
    let store = app
        .store("desktop-state.json")
        .map_err(|e| format!("state_load: {e}"))?;
    Ok(store.get("state").unwrap_or(Value::Null))
}

#[tauri::command]
pub fn desktop_state_save(app: AppHandle, state: Value) -> Result<(), String> {
    let store = app
        .store("desktop-state.json")
        .map_err(|e| format!("state_save: {e}"))?;
    store.set("state", state);
    store.save().map_err(|e| format!("state_flush: {e}"))
}

/* ── Native file dialog (official tauri-plugin-dialog) ─────────────────── */

const DOC_FILTERS: &[(&str, &[&str])] = &[(
    "Documentos",
    &["pdf", "epub", "docx", "txt", "md", "markdown", "html"],
)];

/// Open the native picker and resolve to a filesystem path (None = cancelled).
async fn pick_file(
    app: &AppHandle,
    default_dir: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = app.dialog().file();
    for (name, exts) in DOC_FILTERS {
        dialog = dialog.add_filter(*name, exts);
    }
    if let Some(dir) = default_dir.filter(|d| std::path::Path::new(d).is_dir()) {
        dialog = dialog.set_directory(dir);
    }
    let (tx, rx) = std::sync::mpsc::channel::<Option<tauri_plugin_dialog::FilePath>>();
    dialog.pick_file(move |picked| {
        let _ = tx.send(picked);
    });
    // The callback fires on the main thread; wait here off the UI thread.
    let picked = tauri::async_runtime::spawn_blocking(move || {
        rx.recv_timeout(std::time::Duration::from_secs(600)).ok()
    })
    .await
    .map_err(|_| "dialog_join_failed".to_string())?
    .flatten();
    Ok(picked.and_then(|p| p.into_path().ok().map(|pb| pb.to_string_lossy().to_string())))
}

#[tauri::command]
pub async fn desktop_pick_document(
    app: AppHandle,
    default_dir: Option<String>,
) -> Result<Option<String>, String> {
    pick_file(&app, default_dir).await
}

/// Same native picker, pre-seeded at the directory of a file that went missing.
#[tauri::command]
pub async fn desktop_locate_document(
    app: AppHandle,
    missing_path: String,
) -> Result<Option<String>, String> {
    let default_dir = std::path::Path::new(&missing_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string());
    pick_file(&app, default_dir).await
}

/* ── File read + validation ────────────────────────────────────────────── */

/// Validation result for a document path. Purely structural checks; extension
////type detection stays in the (shared) client adapter registry.
fn validate_document_path(path: &str) -> Result<std::path::PathBuf, String> {
    if !path.starts_with('/') && !path.contains(':') && !path.starts_with('\\') {
        return Err("invalid_path".to_string());
    }
    let p = std::path::PathBuf::from(path);
    let meta = std::fs::metadata(&p).map_err(|_| "file_missing".to_string())?;
    if !meta.is_file() {
        return Err("file_not_a_file".to_string());
    }
    if meta.len() == 0 {
        return Err("empty_file".to_string());
    }
    if meta.len() > MAX_DOCUMENT_BYTES {
        return Err("file_too_large".to_string());
    }
    Ok(p)
}

/// Read a document by path into a raw IPC frame (metadata-free; pure bytes).
#[tauri::command]
pub async fn desktop_read_document(path: String) -> Result<tauri::ipc::Response, String> {
    let p = validate_document_path(&path)?;
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&p).map(tauri::ipc::Response::new).map_err(|_| "file_unreadable".to_string())
    })
    .await
    .map_err(|_| "file_unreadable".to_string())?
}

/* ── Tests ─────────────────────────────────────────────────────────────── */

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_relative_paths() {
        assert_eq!(validate_document_path("relative/file.pdf").unwrap_err(), "invalid_path");
        assert_eq!(validate_document_path("").unwrap_err(), "invalid_path");
    }

    #[test]
    fn absolute_missing_file_reports_missing() {
        let err = validate_document_path(if cfg!(windows) {
            "C:\\definitely\\not\\here\\doc.pdf"
        } else {
            "/definitely/not/here/doc.pdf"
        })
        .unwrap_err();
        assert_eq!(err, "file_missing");
    }

    #[test]
    fn rejects_empty_and_existing_files() {
        let dir = std::env::temp_dir().join("docuvoz-rs-test");
        std::fs::create_dir_all(&dir).unwrap();
        let empty = dir.join("empty.pdf");
        std::fs::write(&empty, b"").unwrap();
        assert_eq!(validate_document_path(&empty_path(&empty)).unwrap_err(), "empty_file");
        std::fs::write(&empty, b"ok").unwrap();
        validate_document_path(&empty_path(&empty)).unwrap();
        std::fs::remove_file(&empty).ok();
    }

    fn empty_path(p: &std::path::Path) -> String {
        p.to_string_lossy().to_string()
    }
}
