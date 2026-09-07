# Accepted security risks (tolerable risk register)

Security alerts reviewed and accepted as tolerable risk, with explicit
reopening conditions. Each entry records the decision rationale so future
maintainers can re-evaluate instead of re-deriving it.

## RUSTSEC-2024-0429 / GHSA-wrw7-89jp-8q8g — glib < 0.20.0

- **Dependabot alert:** #1 (severity: medium)
- **Affected:** `glib >= 0.15.0, < 0.20.0` — `glib 0.18.5` present in
  `src-tauri/Cargo.lock`
- **Advisory:** Unsoundness in `Iterator` and `DoubleEndedIterator` impls for
  `glib::VariantStrIter`

### Rationale (accepted 2026-09-07)

`glib 0.18.5` is a transitive Linux/GTK dependency of the Tauri stack
(enters via the GTK/wry graph in `src-tauri/Cargo.lock`; see also `atk`,
`cairo-rs`, and related crates). DocuVoz v0.2.0-beta.1 distributes Windows
x64 and macOS arm64 artifacts only; no Linux artifact is shipped. The
upstream fix requires the GTK/glib 0.20 stack and cannot be safely upgraded
independently without changing the Tauri/wry dependency graph.

Accepted as tolerable risk until Linux distribution is introduced or the
upstream Tauri stack adopts the patched glib series.

### Review when

- Linux desktop becomes a supported release target, **or**
- Tauri/wry upgrades to a GTK/glib stack using `glib >= 0.20`

This alert is intentionally dismissed as `tolerable_risk` (not `inaccurate`
and not `not_used`): the dependency exists and is reachable in the Linux
build graph; only its shipping surface is absent today.
