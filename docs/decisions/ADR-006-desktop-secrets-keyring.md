# ADR-006: Desktop secret storage — OS keyring (Windows Credential Manager / macOS Keychain)

Status: accepted (v0.2.0-beta.1)

## Context

The desktop build must let users configure the optional NaN service without
editing `.env` files. The API key (`NAN_API_KEY`) is the only secret the
desktop app ever handles. It must not live in localStorage, IndexedDB,
plaintext JSON, or command-line arguments, and must never reach the WebView
(`desktop_nan_key_configured()` exposes only a boolean).

Candidates evaluated:

1. **Tauri Stronghold** — encrypted vault. Requires the user to manage a
   separate vault password, adds a new file format and recovery surface for a
   single secret.
2. **Native OS keyring** (`keyring` crate: Windows Credential Manager /
   macOS Keychain) — OS-managed protection, no extra password, smallest
   reliable surface on exactly the two beta platforms.

## Decision

Use the native OS keyring via the `keyring` crate (`windows-native`,
`apple-native` features). The key is set/cleared from the desktop settings UI
through Rust commands; Rust reads it back only to inject it into the sidecar
process environment at spawn time (together with the non-secret endpoint URL
from the app-data settings store). The WebView receives a boolean
(`configured`) — never the secret. The secret is never logged.

A stronger cipher-in-app-file approach (Stronghold) can replace this later
without changing the WebView contract if cross-platform vault portability
becomes a requirement.

## Consequences

- No additional user-facing password or recovery flow.
- Windows: Credential Manager entry `DocuVoz / nan_api_key`.
- macOS: Keychain generic password item, same names.
- Linux is not a beta target; the keyring crate without a matching feature
  fails fast rather than silently weakening storage.
