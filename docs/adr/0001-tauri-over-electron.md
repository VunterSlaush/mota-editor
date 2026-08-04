# ADR-0001 — Tauri over Electron

- Status: accepted
- Date: 2026-08-04

## Context

Mota Editor must be genuinely lightweight (the reason it exists is to
replace four full VS Code windows), installable on Windows, Linux, and
macOS, and pleasant to keep open all day next to real IDEs.

## Decision

Use **Tauri 2** (Rust backend + system webview UI) rather than Electron.

## Consequences

- Installers are ~10 MB and idle RAM is a fraction of Electron's, because
  the OS webview (WebView2 / WebKitGTK / WKWebView) is reused instead of
  bundling Chromium.
- Native bundles for all three OSes come from `tauri build` (MSI/NSIS,
  AppImage/deb/rpm, dmg/app).
- The backend is Rust: process spawning, streaming, and cancellation are
  handled with tokio; the `agent-core` crate keeps that logic testable.
- Cost accepted: two languages in the repo. Mitigated by keeping the Rust
  side a thin shell — nearly all application logic lives in the
  TypeScript core, and the Rust domain crate is pure and small.
- Cost accepted: contributors need a Rust toolchain plus per-OS webview
  dev packages (documented in the README).
