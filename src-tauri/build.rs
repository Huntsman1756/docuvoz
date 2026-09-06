fn main() {
    // Expose the Rust target triple to the runtime so the sidecar binary can
    // be resolved by its full name (docuvoz-speech-<target-triple>), matching
    // what Tauri writes for `bundle.externalBin`.
    println!(
        "cargo:rustc-env=TAURI_TARGET={}",
        std::env::var("TARGET").expect("TARGET env var set by cargo")
    );
    tauri_build::build()
}
