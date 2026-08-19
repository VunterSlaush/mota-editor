# Architecture

Mota Editor is a lightweight, cross-platform (Windows/Linux/macOS) workbench
for driving AI coding agents across several projects at once: **one tab per
project, one chat per tab, any agent per chat** (Claude, ChatGPT/Codex,
Gemini).

The design follows Robert C. Martin's Clean Architecture. The governing
principle is the **Dependency Rule**:

> "Source code dependencies can only point inwards."
> — [The Clean Architecture](https://blog.cleancoder.com/uncle-bob/2012/08/13/the-clean-architecture.html)

Nothing in an inner circle knows any name declared in an outer circle. Data
crossing a boundary is always a simple structure (DTO), never a framework
object.

## The circles, mapped to this codebase

The app has two processes — a TypeScript frontend (the UI) and a Rust
backend (the shell that spawns agent CLIs). Each side is layered
independently, and the same Dependency Rule applies in both.

```
             ┌────────────────────────────────────────────────────┐
             │ Frameworks & Drivers                               │
             │  React components (src/ui)     Tauri, tokio        │
             │  Vite, webview                 (src-tauri/src)     │
             │  ┌──────────────────────────────────────────────┐  │
             │  │ Interface Adapters                           │  │
             │  │  src/adapters/tauri/*  (gateway impls)       │  │
             │  │  src-tauri/src/commands.rs (controllers)     │  │
             │  │  ┌────────────────────────────────────────┐  │  │
             │  │  │ Use Cases                              │  │  │
             │  │  │  src/core/usecases/*                   │  │  │
             │  │  │  ┌──────────────────────────────────┐  │  │  │
             │  │  │  │ Entities                         │  │  │  │
             │  │  │  │  src/core/entities/*             │  │  │  │
             │  │  │  │  src-tauri/agent-core (events,   │  │  │  │
             │  │  │  │  providers)                      │  │  │  │
             │  │  │  └──────────────────────────────────┘  │  │  │
             │  │  └────────────────────────────────────────┘  │  │
             │  └──────────────────────────────────────────────┘  │
             └────────────────────────────────────────────────────┘
                        dependencies point inward only →
```

### Frontend (TypeScript, `src/`)

| Layer | Location | Contents | May import from |
|---|---|---|---|
| Entities | `src/core/entities/` | `Project`, `ChatMessage`, `ProviderDescriptor` | nothing |
| Use cases | `src/core/usecases/` + `src/core/state/` | `SendPrompt`, `OpenProject`, `CancelTurn`, …; the pure `AppState` reducer and framework-free `Store` | entities, ports |
| Ports (owned by the core) | `src/core/ports/` | `AgentGateway`, `WorkspaceStore`, `FolderPicker` — interfaces the use cases call outward through | entities |
| Interface adapters | `src/adapters/tauri/` | `TauriAgentGateway`, `TauriWorkspaceStore`, `TauriFolderPicker` — implement the ports over Tauri IPC | core (ports + entities), `@tauri-apps/*` |
| Frameworks & drivers | `src/ui/` | Humble React views: render state, forward intents. No business decisions. | core state (read), use cases (call) |
| Composition root | `src/wiring/context.ts` | The one place concrete adapters are chosen and injected (the `Context` idea from the Clean Coders case study) | everything |

Key consequences:

- `src/core/**` imports **no React and no Tauri**. It is exercised by fast
  unit tests (`vitest`) with in-memory fakes — the whole point of the
  architecture: "unit-test all those use cases without any of the
  frameworks in place."
- The UI is a **Humble View**. `App.tsx` and the components contain zero
  conditional business logic beyond rendering; every intent is one call
  into a use case.
- Crossing the frontend/backend boundary uses DTOs only: the wire event
  shape in `tauriAgentGateway.ts` mirrors `agent-core`'s serialized
  `AgentEvent` and is converted to the core's `AgentTurnEvent` at the
  boundary — outer formats never leak inward.

### Backend (Rust, `src-tauri/`)

| Layer | Crate / location | Contents |
|---|---|---|
| Entities + provider boundary | `src-tauri/agent-core/` | `AgentEvent` (the domain vocabulary of a turn), the `Provider` trait, and one adapter per vendor CLI (`claude.rs`, `codex.rs`, `gemini.rs`). **No I/O, no Tauri, no processes** — pure parsing and command description, fully unit-tested. |
| Interface adapters | `src-tauri/src/commands.rs` | Tauri command controllers: validate, delegate, return. |
| Frameworks & drivers | `src-tauri/src/runner.rs`, `workspace_file.rs`, `lib.rs` | Process spawning (tokio), event emission over Tauri, JSON persistence, app bootstrap. |

`agent-core` never spawns a process: a provider **describes** its command
(`TurnCommand`) and **translates** output lines into events; the shell
executes and streams. That inversion is what makes every provider's parser
testable in milliseconds and keeps CLI drift contained in one file per
vendor.

## The agent boundary (why CLIs, and how it stays swappable)

The chat UI never knows how an answer is produced. The frontend core
depends only on the `AgentGateway` port:

```
ChatPanel → SendPrompt (use case) → AgentGateway (port)
                                        │
                          TauriAgentGateway (adapter, IPC)
                                        │
                    commands.rs → runner.rs → Provider (trait)
                                        │
                     claude / codex / gemini CLI, headless mode
```

v1 drives each vendor's official CLI in headless streaming mode (`claude -p
--output-format stream-json`, `codex exec --json`, `gemini -p
--output-format json`), inheriting each vendor's login, tools, and
permission model for free (see ADR-0002). Because both the frontend port
and the Rust `Provider` trait are owned by inner layers, a direct-API
adapter (Anthropic/OpenAI/Google HTTP APIs) can be added later without
touching a single use case — the definition of OCP at the boundary.

## The extension boundary (user-installed, out-of-process)

Extensions follow the same shape as agents: a subprocess behind a port,
speaking newline-delimited JSON-RPC (the Mota Extension Protocol,
ADR-0012). An extension is a folder in `~/.mota/extensions/` — a manifest
declaring contributions (slash commands, MCP servers, event
subscriptions) and permissions, plus optionally a script in any language.

```
SettingsExtensions / SendPrompt → ExtensionHostPort (port)
                                        │
                        TauriExtensionHost (adapter, IPC)
                                        │
              extension_host.rs (spawn, route, permission broker)
                                        │
                  the extension's own process, MXP over stdio
```

Pure manifest/protocol logic lives in `agent_core::extension`; the shell
spawns lazily (a contribution's first use), enforces permissions against
grants in `extensions.json` (minted only behind a native consent dialog),
and quarantines repeat crashers. Extension MCP servers ride the existing
`mcpServer` plumbing as derived rows; extension commands merge into the
same palette as builtins and file commands. Authoring guide:
`docs/EXTENSIONS.md`.

## Screaming architecture

> "So what does the architecture of your application scream?"
> — [Screaming Architecture](https://blog.cleancoder.com/uncle-bob/2011/09/30/Screaming-Architecture.html)

The top-level folders scream the domain — `entities`, `usecases`, `ports`,
`providers` — not the frameworks. Tauri, React, and tokio each appear in
exactly one outer-layer directory and could be replaced "with a minimum of
fuss": swapping Tauri for Electron would touch `src/adapters/tauri/`,
`src/wiring/`, and `src-tauri/src/` only.

## Data & control flow of one turn

1. User hits Enter in `Composer` → `SendPrompt.execute(tabId, prompt)`.
2. The use case appends the user message, marks the tab busy, and calls
   `AgentGateway.startTurn` with a request DTO (including the provider
   session id to resume, if any).
3. `TauriAgentGateway` subscribes to `agent-event` and invokes `start_turn`.
4. `commands.rs` validates, asks the `Provider` for its `TurnCommand`, and
   `runner.rs` spawns the CLI with `cwd = project folder`.
5. Each stdout line goes through `Provider::parse_line` → `AgentEvent` →
   emitted to the frontend → converted at the adapter boundary → folded
   into `AppState` by the use case → React re-renders.
6. On exit, the runner guarantees exactly one `TurnCompleted`; the use case
   records the provider session id and persists the workspace.

## Persistence

Open tabs, per-tab provider choice, and provider session ids survive
restarts in one JSON file in the OS app-config directory (see
`workspace_file.rs`). The backend treats the payload as opaque; its schema
is owned by the frontend core (`PersistedWorkspace`). Chat messages are
deliberately not persisted there — the provider session id is what lets a
conversation resume.

The conversation itself is written to session history after every turn
(`history_file.rs`, one file per chat). It carries two ids: ours, which
names the file, and the provider's, which names the agent's own session.
Both are needed — the History panel lists our transcripts and the agent's
sessions together, and only the provider id can tell when a row from each
side is the same conversation. The workspace file also remembers which
transcript a tab was writing to, so a frontend reload (the backend
session outlives it) keeps appending to that chat instead of starting a
new one; the claim is honoured only while the agent is still in the same
session.

## Testing strategy

- **Unit (fast, framework-free):** the reducer, every use case (with fake
  gateways, exactly like the case study's in-memory gateways), and every
  provider parser. These are the tests that run on every change.
- **The edges stay humble:** `runner.rs`, `commands.rs`, and the React
  components contain as little decision logic as possible, which is what
  makes skipping heavyweight UI tests a deliberate trade rather than a gap.
- Rules for contributions are in [CODING_STANDARDS.md](CODING_STANDARDS.md).

## Decision log

Significant decisions are recorded as ADRs in [`docs/adr/`](adr/):

- [ADR-0001 — Tauri over Electron](adr/0001-tauri-over-electron.md)
- [ADR-0002 — Chat UI over headless vendor CLIs](adr/0002-headless-cli-agents.md)
- [ADR-0003 — Two-sided Clean Architecture with ports at every boundary](adr/0003-clean-architecture-layout.md)
- [ADR-0004 — Modes and permissions over headless CLIs](adr/0004-modes-and-permissions.md)
- [ADR-0005 — Interactive agent sessions over ACP](adr/0005-acp-interactive-sessions.md)
- [ADR-0016 — A conversation has an identity, and a retired chat keeps its agent](adr/0016-retired-chats.md)
