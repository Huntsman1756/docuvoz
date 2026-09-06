#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! DocuVoz desktop (Tauri v2) bridge.
//!
//! Owns the Node speech sidecar lifecycle and proxies the WebView's three
//! commands (`speech_health`, `speech`, `speech_cancel`) to the loopback HTTP
//! surface of the sidecar.
//!
//! Security model:
//!   - The sidecar binds 127.0.0.1:0 and requires a per-process bearer token.
//!   - The token and the sidecar port live ONLY in Rust state; they are never
//!     sent to the WebView.
//!   - The token is passed to the sidecar via an environment variable (never a
//!     CLI argument, which other local processes could observe).
//!   - The WebView gets no shell/process spawning capability.
//!   - The binary frame (`metadata | audio`) is proxied through
//!     `tauri::ipc::Response` as raw bytes — no base64, no header hacks.

use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Manager, RunEvent, State};

mod desktop;

/// Bounded startup wait for the sidecar's READY line.
const STARTUP_TIMEOUT: Duration = Duration::from_secs(30);
/// Backstop for a full synthesis request; the sidecar enforces its own 60s
/// operation deadline, so this only catches a wedged process.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(90);

struct Sidecar {
    child: Child,
    port: u16,
    token: String,
    /// Windows: keeps the kill-on-close job object alive for the child.
    #[cfg(windows)]
    _job: Option<win32job::Job>,
}

struct AppState {
    sidecar: Mutex<Option<Sidecar>>,
    http: reqwest::Client,
    sidecar_binary: PathBuf,
    cache_dir: PathBuf,
    app: tauri::AppHandle,
}

impl AppState {
    /// Return (port, token), respawning the sidecar once if it died
    /// (crash recovery; deliberate no-supervisor simplicity).
    fn ensure_sidecar(&self) -> Result<(u16, String), String> {
        let mut guard = self.sidecar.lock().map_err(|_| "state_poisoned")?;
        let dead = match guard.as_mut() {
            None => true,
            Some(s) => matches!(s.child.try_wait(), Ok(Some(_))),
        };
        if dead {
            if guard.take().is_some() {
                eprintln!("docuvoz-speech died; attempting one restart");
            }
            let sidecar = spawn_sidecar(&self.app, &self.sidecar_binary, &self.cache_dir)?;
            *guard = Some(sidecar);
        }
        let s = guard.as_ref().ok_or("sidecar_unavailable")?;
        Ok((s.port, s.token.clone()))
    }
}

fn hex_token() -> String {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).expect("OS CSPRNG unavailable");
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

fn spawn_sidecar(
    app: &tauri::AppHandle,
    binary: &PathBuf,
    cache_dir: &PathBuf,
) -> Result<Sidecar, String> {
    std::fs::create_dir_all(cache_dir).map_err(|e| format!("cache_dir: {e}"))?;
    let token = hex_token();
    let mut command = Command::new(binary);
    command
        .env("DOCUVOZ_SIDECAR_TOKEN", &token)
        .env("EDGE_TTS_ENABLED", "1")
        .env("SPEECH_CACHE_DIR", cache_dir)
        .env_remove("SPEECH_PROVIDER")
        .env_remove("NAN_BASE_URL")
        .env_remove("NAN_API_KEY");
    // Real standard engine: only when the user configured both the endpoint
    // (non-secret, in app-data settings) and the API key (OS keyring).
    // Otherwise the default engine stays mock and Edge is the only real
    // voice — a missing key must never silently become a Mock substitute
    // pretending to be a real provider.
    if let (Some(key), Some(url)) = (desktop::nan_api_key(), desktop::nan_base_url(app)) {
        command.env("SPEECH_PROVIDER", "nan");
        command.env("NAN_BASE_URL", url);
        command.env("NAN_API_KEY", key);
    }
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());

    let mut child = command
        .spawn()
        .map_err(|e| format!("sidecar_spawn_failed: {e}"))?;

    // Read exactly one READY {"port":N} line, with a bounded timeout.
    let stdout = child.stdout.take().ok_or("sidecar_stdout_unavailable")?;
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    if l.starts_with("READY ") {
                        let _ = tx.send(l);
                        return;
                    }
                }
                Err(_) => return,
            }
        }
    });
    let ready = rx
        .recv_timeout(STARTUP_TIMEOUT)
        .map_err(|_| {
            let _ = child.kill();
            "sidecar_startup_timeout"
        })?;
    let payload = ready.trim_start_matches("READY ").trim();
    let port = serde_json::from_str::<Value>(payload)
        .ok()
        .and_then(|v| v.get("port").and_then(Value::as_u64))
        .filter(|p| *p > 0 && *p <= 65535)
        .ok_or_else(|| {
            let _ = child.kill();
            "sidecar_ready_invalid"
        })? as u16;

    #[cfg(windows)]
    let job = {
        use std::os::windows::io::AsRawHandle;
        match win32job::Job::create() {
            Ok(job) => match job.query_extended_limit_info() {
                Ok(mut info) => {
                    // Kill-on-close: if the desktop process dies, the sidecar dies.
                    info.limit_kill_on_job_close();
                    match job.set_extended_limit_info(&info) {
                        Ok(()) => match job.assign_process(child.as_raw_handle() as isize) {
                            Ok(()) => Some(job),
                            Err(_) => None,
                        },
                        Err(_) => None,
                    }
                }
                Err(_) => None,
            },
            Err(_) => None,
        }
    };

    Ok(Sidecar {
        child,
        port,
        token,
        #[cfg(windows)]
        _job: job,
    })
}

#[tauri::command]
async fn speech_health(state: State<'_, AppState>) -> Result<Value, String> {
    let (port, token) = state.ensure_sidecar()?;
    let url = format!("http://127.0.0.1:{port}/health");
    let response = state
        .http
        .get(&url)
        .bearer_auth(&token)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| "bridge_unreachable".to_string())?;
    if !response.status().is_success() {
        return Err("sidecar_unavailable".to_string());
    }
    response
        .json::<Value>()
        .await
        .map_err(|_| "bridge_invalid_response".to_string())
}

#[tauri::command]
async fn speech(
    request_id: String,
    text: String,
    voice: Option<String>,
    engine: Option<String>,
    speed: Option<f64>,
    state: State<'_, AppState>,
) -> Result<tauri::ipc::Response, String> {
    if request_id.is_empty() || request_id.len() > 128 {
        return Err("invalid_request".to_string());
    }
    let (port, token) = state.ensure_sidecar()?;
    let mut body = Map::new();
    body.insert("text".into(), json!(text));
    if let Some(v) = voice {
        body.insert("voice".into(), json!(v));
    }
    if let Some(e) = engine {
        body.insert("engine".into(), json!(e));
    }
    if let Some(s) = speed {
        body.insert("speed".into(), json!(s));
    }
    let url = format!("http://127.0.0.1:{port}/speech?requestId={request_id}");
    let response = state
        .http
        .post(&url)
        .bearer_auth(&token)
        .json(&body)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|_| "bridge_unreachable".to_string())?;
    let bytes = response
        .bytes()
        .await
        .map_err(|_| "bridge_unreachable".to_string())?;
    // Raw binary frame straight to the WebView (no base64, no headers).
    Ok(tauri::ipc::Response::new(bytes.to_vec()))
}

#[tauri::command]
async fn speech_cancel(request_id: String, state: State<'_, AppState>) -> Result<(), String> {
    let (port, token) = match state.ensure_sidecar() {
        Ok(pair) => pair,
        // Nothing to cancel if the sidecar is gone; cancellation is best-effort.
        Err(_) => return Ok(()),
    };
    let url = format!("http://127.0.0.1:{port}/cancel/{request_id}");
    let _ = state
        .http
        .post(&url)
        .bearer_auth(&token)
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    Ok(())
}

fn kill_sidecar(state: &AppState) {
    if let Ok(mut guard) = state.sidecar.lock() {
        if let Some(mut sidecar) = guard.take() {
            let _ = sidecar.child.kill();
            let _ = sidecar.child.wait();
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .setup(|app| {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let dir = exe.parent().ok_or("no exe dir")?;
            let ext = if cfg!(windows) { ".exe" } else { "" };
            // Tauri places external binaries next to the app binary:
            //   - dev builds keep the target-triple suffix;
            //   - bundles install the plain name.
            let candidates = [
                dir.join(format!("docuvoz-speech-{}{ext}", env!("TAURI_TARGET"))),
                dir.join(format!("docuvoz-speech{ext}")),
            ];
            let sidecar_binary = candidates
                .iter()
                .find(|p| p.exists())
                .ok_or_else(|| {
                    format!(
                        "sidecar binary missing: {}",
                        candidates.iter().map(|p| p.display().to_string()).collect::<Vec<_>>().join(" | ")
                    )
                })?
                .clone();
            let cache_dir = app
                .path()
                .app_cache_dir()?
                .join("speech-cache");
            let handle = app.handle().clone();
            let sidecar = spawn_sidecar(&handle, &sidecar_binary, &cache_dir)
                .map_err(|e| -> Box<dyn std::error::Error> { e.into() })?;
            app.manage(AppState {
                sidecar: Mutex::new(Some(sidecar)),
                http: reqwest::Client::new(),
                sidecar_binary,
                cache_dir,
                app: handle,
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            speech_health,
            speech,
            speech_cancel,
            desktop::desktop_pick_document,
            desktop::desktop_locate_document,
            desktop::desktop_read_document,
            desktop::desktop_state_load,
            desktop::desktop_state_save,
            desktop::desktop_nan_key_configured,
            desktop::desktop_set_nan_key,
            desktop::desktop_clear_nan_key
        ])
        .build(tauri::generate_context!())
        .expect("tauri application failed to initialize")
        .run(|_app, event| {
            if let RunEvent::Exit = event {
                kill_sidecar(&_app.state::<AppState>());
            }
        });
}
