# ADR-0012 — Out-of-process extensions over the Mota Extension Protocol

- Status: accepted
- Date: 2026-08-12
- Relates to: ADR-0001 (lightweight is the product), ADR-0005 (ACP sessions
  — the stdio JSON-RPC pattern this copies), ADR-0008 (argv-only spawning)

## Context

Users want to extend the workbench: their own slash commands, tools for
their agents, automation that reacts to a finished turn. The app already
has three extension-shaped mechanisms — MCP servers users configure by
hand, slash commands discovered from markdown on disk, and the
compile-time `Provider` registry — but no way to install a third-party
artifact that contributes to any of them.

Two constraints shape the answer. First, being lightweight is the product
(ADR-0001): ten installed extensions must not mean ten resident Node
processes. Second, the webview runs with the full Tauri command surface
and, until this ADR, no CSP — so running third-party JavaScript *inside*
the webview would hand every extension the whole app.

## Decision

- **An extension is a folder**: `mota-extension.json` plus, optionally,
  any executable. Installed by dropping it into `~/.mota/extensions/<id>/`
  (or a repo's `.mota/extensions/`, origin-flagged and never auto-enabled).
  No marketplace, no packaging format, no signing in v1.
- **The process speaks MXP v1** — JSON-RPC 2.0, newline-delimited, over
  stdio: the same wire family as ACP and MCP, so an author who has written
  either feels at home. Same drift posture too: versioned `initialize`,
  `-32601` for unknown requests, unknown notifications and manifest fields
  ignored. Unknown *permission* strings fail closed as `incompatible` — a
  manifest written for a newer host is never silently granted.
- **Contributions are declarative, processes are lazy.** Everything an
  extension offers (commands, MCP servers, event subscriptions) is in the
  manifest; discovery is a JSON scan. Nothing spawns until a contribution
  is used, pure-data extensions (prompt commands) never spawn at all, and
  idle command-only processes are reaped. One singleton process per
  extension — not per tab; requests carry `{tabId, projectPath}`.
- **Trust is informed consent, not a sandbox.** The manifest declares
  permissions from a closed vocabulary; enabling shows a **native** OS
  dialog listing them; the grant lands in `extensions.json` beside
  `workspace.json` — deliberately *not* in the webview-owned workspace
  blob, so a compromised webview can ask but cannot approve (it never
  supplies the permission list either; Rust re-reads the manifest from
  disk). A changed permission set flips the extension back to
  needs-approval. The Rust broker is the sole enforcement point: every
  extension→host call passes `required_permission` before dispatch.
  Under this model `shell:exec` ≈ the user's own privileges — the dialog
  says so plainly rather than pretending otherwise.
- **The layering is ACP's, verbatim.** Pure protocol/manifest logic in
  `agent_core::extension` (serde-only, covered by the existing
  `agent-core-purity` rule); mechanical spawn/route/broker in
  `src-tauri/src/extension_host.rs` + `extension_discovery.rs`; one
  `"extension-event"` channel mirroring `"agent-event"`; frontend port
  (`ExtensionHostPort`) with Tauri and demo adapters, wired in
  `src/wiring/context.ts`.
- **Contributions ride existing plumbing.** Extension MCP servers become
  derived `McpServerConfig` rows (`ext:<id>:<name>`, never persisted) fed
  through the same `serversForProvider` filter (`agentServers`). Extension
  commands merge into `ListCommands` under a new `"extension"` source;
  name clashes resolve deterministically (builtins win; contested names
  list only as `/<ext>.<name>`). Prompt-template commands expand
  client-side; programmatic ones return a validated **action list**
  instead of arbitrary capability.
- **Hardening lands with it**: a real CSP (previously `null`),
  `dialog:allow-ask` for the consent dialog, `confine_to_project`
  extracted to a shared `fs_confine.rs`, and two new mechanical rules —
  `process-spawn-discipline` (no raw `Command::new` outside `runner.rs`
  and a reviewed allowlist) and `extension-grant-locality`
  (`extensions.json` is named by `extension_host.rs` alone).

## Consequences

- Seven new Tauri commands, one event channel, one new port. No new
  dependencies on either side of the boundary.
- Crash containment is behavioral, not supervisory: a dead process fails
  its pending calls, restarts on the next trigger, and three crashes in a
  minute quarantine the extension until the user re-enables it. There are
  no restart timers to leak.
- The manifest and event payloads become public API at first ship —
  evolution is additive only, under the same `protocolVersion` until a
  breaking change forces 2.
- Later phases build on this without rework: workbench events
  (`turn/completed` fan-out with loop guards), `host/fs`/`host/exec`
  brokered calls, declarative sidebar panels, and — last, if ever —
  runtime AI providers restricted to ACP-speaking agents. The broker's
  permission table already names them; unimplemented methods answer with
  an honest error today.
- `host/notify` round-trips through the webview because the
  `NotificationPort` (and its focus suppression) lives there; background
  operation would move that to Rust.
- Windows caveat inherited from `lib.rs`: `TerminateProcess` reaches the
  direct child only, so an extension's grandchildren can outlive it — the
  job-object follow-up noted there gains value.

## Alternatives considered

- **JS extensions loaded into the webview** (VS Code's model) — the best
  DX and the only path to arbitrary extension UI, but third-party code in
  the webview inherits the full invoke surface, breaks the Dependency
  Rule (extensions would import app internals), and demands a mature
  API-broker + CSP story before anything ships. Out-of-process keeps the
  boundary where the architecture already draws it.
- **One shared extension-host runtime** (a single Node process hosting
  all extensions) — cheaper per extension but no longer language-agnostic,
  a resident cost even when idle, and one crash felling every extension.
- **WASM** — real sandboxing, but hostile to "any script the user can
  write" (Python, bash, a compiled tool), a heavyweight runtime
  dependency against ADR-0001, and overkill for a trusted-local model
  whose real gate is the consent dialog.
