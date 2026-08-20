# ADR-0013 — Declarative sidebar panels for extensions

- Status: accepted
- Date: 2026-08-13
- Relates to: ADR-0012 (extensions over stdio — names this phase), ADR-0001
  (lightweight is the product)

## Context

ADR-0012 shipped extensions with three contribution kinds — commands, MCP
servers, event subscriptions — and deliberately deferred UI. The permission
vocabulary already reserved `ui:panel`, the broker already answered
`panels/refresh` with an empty ack, and the alternatives section recorded
why arbitrary extension UI (webview-loaded JavaScript) was rejected: it
hands third-party code the full invoke surface.

The first real demand has arrived: a Linear extension that lists your
issues in the sidebar, grouped by status, with inline status changes and a
detail view. That shape — *a grouped list of items with a small set of
interactions* — covers a large family of panels (issues, PRs, CI runs,
tickets) without needing arbitrary UI.

## Decision

- **Panels are declarative data, rendered by the host.** An extension
  contributes `panels: [{ id, title, icon? }]` in its manifest (gated by
  `ui:panel`, requires an `entry`). The host draws one activity-bar icon
  per panel of an enabled extension. Opening it asks the extension for a
  **view model** in a closed vocabulary — groups of items with title,
  subtitle, badge, and an optional per-item `select` control — and renders
  it with the app's own React components. No extension code ever runs in
  the webview; the trust posture of ADR-0012 is unchanged.
- **Two host→extension requests, additive under MXP v1.**
  `panel/load {panelId, context}` → `{view}`, and
  `panel/action {panelId, action, itemId, value?, context}` →
  `{view?, detail?}`. The action vocabulary is owned by the host and is
  deliberately tiny: `"open"` (item clicked — answer with a `detail` the
  host shows in a modal) and `"select"` (the item's select control changed
  — answer with the updated `view`). `context` carries `{tabId,
  projectPath}` exactly like `command/execute`.
- **Refresh is a pull the extension may provoke.** The panel has a refresh
  button (a fresh `panel/load`), and the already-known `panels/refresh`
  notification from the extension now emits a `panelChanged` event to the
  webview, which re-pulls if that panel is open. No push of view data —
  the host never renders anything it did not just ask for.
- **Validation lives in the frontend core, like actions.** The Rust broker
  stays mechanical: it routes the JSON result through untouched. The
  frontend core parses the view into typed entities with hard caps
  (groups, items, option counts, text lengths) and drops what it does not
  recognize — the same posture as `parseExtensionActions`. Unknown fields
  are ignored, so the vocabulary can grow additively.
- **Layering is ADR-0012's, verbatim.** Manifest parsing and request
  framing in `agent_core::extension`; two new Tauri commands brokered by
  `extension_host.rs`; `ExtensionHostPort` grows `loadPanel`/`panelAction`
  with Tauri and demo adapters; the panel list rides the existing
  extension descriptors; the React panel and its detail modal are humble
  views fed through props.

## Consequences

- Two new Tauri commands, no new dependencies, no new event channel
  (`panelChanged` rides `"extension-event"`).
- Panel content is view-local state (like the history list), not
  `AppState`: closing the panel forgets it, reopening re-pulls.
- A slow extension blocks only its own panel: requests carry the existing
  30 s command budget and failures render as a panel error state.
- The vocabulary will grow (buttons, filters, forms) — additively, behind
  the same two requests. If a panel ever needs arbitrary UI, that is a new
  ADR, not a stretch of this one.
- Icons are named, not supplied: the manifest names one of a small set the
  host maps to its icon font, so extensions cannot draw arbitrary pixels
  in the activity bar.

## Alternatives considered

- **Webview/iframe panels** (VS Code's model) — already rejected in
  ADR-0012 for the webview trust boundary; nothing changed.
- **HTML strings sanitized by the host** — sanitizers are a treadmill, and
  styling could never match the app. A closed vocabulary is smaller,
  themeable for free, and honest about what extensions may do.
- **Panels as MCP tools the agent renders in chat** — puts an AI turn (and
  its cost) between the user and their task list; a sidebar panel is a
  direct read, not an agent capability.
