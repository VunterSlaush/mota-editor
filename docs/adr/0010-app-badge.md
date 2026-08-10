# ADR-0010 — The app badge, and AppKit for the dock tile

- Status: accepted
- Date: 2026-08-10
- Relates to: ADR-0001 (Tauri over Electron), ADR-0003 (clean architecture layout)

## Context

The tab bar already says which project needs you — a colored dot per
tab, `tabStatus` in the core. It says nothing when the window is
minimised, and that is precisely when an agent finishing, failing, or
stopping to ask a question matters most: the work is happening while you
are elsewhere. Every app people compare this to (Discord, Linear, Slack)
answers that with a count on its own icon.

The awkward part is that "put a number on the app icon" is three
different capabilities:

- **Windows** has no badge API at all. `set_overlay_icon` takes an
  *image*, and the taskbar composites it over the app button.
- **macOS** has `NSDockTile.badgeLabel`, which draws a red pill. The
  count is honest; the color is AppKit's and cannot be set.
- **Linux** exposes a count through the Unity launcher API, which
  GNOME-with-dash-to-dock and KDE honor and other desktops ignore.

A badge that could not carry the color would have thrown away the
distinction the tab dots already make between "working", "finished",
"needs you" and "failed".

## Decision

- **What the badge means is decided in the core.** `appBadge()`
  (entities) folds the tabs' existing `tabStatus` into one
  `{ level, count }`: the worst state present wins, and the count is the
  tabs in *that* state. The two indicators can never disagree, because
  there is one status function.
- **What the badge looks like is decided in `agent_core::badge`** —
  pure arithmetic producing RGBA bytes, no platform, no I/O, unit
  tested. Colors are the tab dots' own (`--error`, `--warning`,
  `--success`, `--accent`). Digits come from a hand-written 3x5 bitmap
  font: ten glyphs, ~50 bytes of table, rather than a font or image
  crate to draw ten glyphs.
- **Which surface receives it is the shell's only job** (`app_badge.rs`,
  behind `#[cfg]`): overlay icon on Windows, dock tile on macOS,
  `set_badge_count` elsewhere.
- **macOS takes the dock tile over.** `NSDockTile.setContentView` with
  the app icon plus our badge in the corner, which is what the platform's
  chat apps do and the only way the color survives. This needs AppKit,
  so `objc2` + `objc2-app-kit` + `objc2-foundation` join the build —
  **mac-only, in `[target.'cfg(target_os = "macos")'.dependencies]`**.
- The frontend pushes the badge **only when it changes** (`sameBadge`),
  so a streaming turn's thousands of dispatches cost zero IPC calls.

## Consequences

- Three new dependencies, all already present in `Cargo.lock` (tao and
  muda pull them), so this adds no crate to download and no lock churn.
  They compile on macOS only; the Windows and Linux binaries are
  byte-identical to what they were.
- One `unsafe` block, in one module, for one job: handing AppKit a
  bitmap it will own. Its safety argument is local — a null `planes`
  makes `NSBitmapImageRep` allocate a buffer of exactly the shape
  `badge_rgba` produced.
- AppKit is main-thread-only and Tauri commands are not, so the macOS
  path hops through `run_on_main_thread`. Every failure there is silent:
  a dock decoration is not worth a dialog.
- **The macOS path ships type-checked but not run.** It was verified by
  cross-compiling the module for `aarch64-apple-darwin`; nobody has seen
  it on a dock. The Windows path was verified by rendering its pixels.
- Linux inherits whatever its desktop does with a launcher count,
  including nothing. That is the platform's answer, not ours, and the
  alternative (a tray icon) was declined: it adds a permanent menu-bar
  presence for an indicator that is meant to be glanceable, not resident.

## Alternatives considered

- **A tray / menu-bar icon** — the one surface where we control the
  pixels on all three platforms, and the only way Linux gets color. It
  costs a permanent tray presence and, on Linux, an appindicator system
  package. Available later without undoing any of this: the core badge
  and the port stay as they are, only a second adapter target is added.
- **An emoji in the macOS badge label** (`setBadgeLabel("🟡 3")`) — one
  line, no dependency, but a colored glyph on AppKit's red pill reads
  worse than the plain red count it replaces.
- **Rendering the whole dock icon ourselves** via
  `NSApp.setApplicationIconImage` — same dependency, but it also changes
  the Cmd-Tab switcher and has to restore the original icon on clear.
  The dock tile's content view is scoped to the dock, which is the
  surface the badge is about.
