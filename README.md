# Mota Editor

A lightweight, cross-platform workbench for running AI coding agents across
several projects at once. **One tab per project. One chat per tab. Any
agent per chat** — Claude, ChatGPT (Codex), or Gemini.

Instead of keeping four IDE windows open just to talk to agents, open each
project as a tab and chat with the agent of your choice, with the
conversation running in that project's folder.

## How it works

Each tab holds a persistent **Agent Client Protocol (ACP)** session with
the vendor's agent, running in the project folder: responses stream
token by token, and when the agent wants to do something risky it asks
**in the chat** — you click Allow or Deny. The agents keep their own
login, tools, and file-editing abilities; Mota Editor gives them tabs, a
chat UI, and an approval flow.

| Provider | ACP agent (interactive mode) | Sign in once with |
|---|---|---|
| Claude | `npm i -g @agentclientprotocol/claude-agent-acp` | `claude` (Claude Code login) |
| ChatGPT | `npm i -g @agentclientprotocol/codex-acp` | `codex` (ChatGPT login) |
| Gemini | `npm i -g @google/gemini-cli` (has ACP built in: `gemini --acp`) | `gemini` |

The global installs are optional but **strongly recommended for speed**:
Mota Editor tries the globally-installed adapter binary first (instant
startup) and only falls back to `npx`, which re-resolves — and on first
use downloads — the package on every session start. If an agent can't be
launched at all, the tab falls back to one-shot headless CLI mode
automatically (everything works, but approvals become safe-defaults
instead of interactive — see ADR-0004/0005).

Per tab you can also pick the **model** (type any vendor model id or
pick a suggestion; empty = provider default — changing it restarts that
tab's agent session on the next message), and typing `/` shows the
**agent's own command list** — the running agent advertises its real
built-ins, skills, and custom commands over ACP, so what you see is what
that CLI actually supports.

## Development

Prerequisites:

- Node 20+ and Rust stable (`rustup`)
- OS packages for Tauri:
  - **Windows:** WebView2 (preinstalled on Windows 10/11), MSVC Build Tools
  - **Linux:** `libwebkit2gtk-4.1-dev libgtk-3-dev librsvg2-dev` (Debian/Ubuntu names)
  - **macOS:** Xcode Command Line Tools

```
npm install
npm run tauri dev       # run with hot reload
npm run tauri build     # native installers (MSI/NSIS, AppImage/deb/rpm, dmg)
```

Quality gates:

```
npm run typecheck                     # strict TypeScript
npm test                              # frontend core unit tests (vitest)
cd src-tauri && cargo test -p agent-core   # provider/domain tests
cd src-tauri && cargo clippy --workspace   # zero warnings policy
```

## Architecture

Clean Architecture on both sides of the process boundary; business rules
are framework-free and fully unit-tested. Start with
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md), then
[docs/CODING_STANDARDS.md](docs/CODING_STANDARDS.md) and the ADRs in
[docs/adr/](docs/adr/). Contributions: [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md).

```
src/core        entities · use cases · ports        (pure TypeScript)
src/adapters    Tauri implementations of the ports
src/ui          humble React views
src/wiring      composition root
src-tauri/agent-core   provider domain crate        (pure Rust)
src-tauri/src   Tauri shell: controllers · process runner · persistence
```

## Status

v1: tabs, per-project chat, provider switching, workspace persistence,
cancellation, per-tab **mode** (agent/plan/debug), **permissions**
(manual approval / bypass — plan approvals are ALWAYS surfaced to you,
even under bypass), **model selector**, **interactive in-chat
approvals**, **token-level streaming**, a live **plan panel** (the
agent's plan with per-step status), an **agent thoughts** view, a
**verbose toggle** (on: everything the agent does; off: just the
conversation), a **Changes panel** (staged / not-staged files via git),
a **slash-command palette** fed by the running agent's own command list,
and **file attachments**. Not yet: transcript persistence across
restarts, direct-API providers.
