# ADR-0017 — Remote Control is not reachable over ACP

- Status: accepted
- Date: 2026-08-18
- Extends: ADR-0005 (interactive agent sessions over ACP), ADR-0011
  (agent-initiated turns)

## Context

Claude Code can be driven from claude.ai and from a phone: `/remote` in
the REPL, `claude --remote-control [name]` on the command line, a
`remoteControlAtStartup` setting, and a bridge/worker architecture with
a session registry at `~/.claude/sessions/<pid>.json`.

Wanting the same from Mota is reasonable, and the first look was
encouraging:

- The registry already lists Mota's own sessions. Every entry the ACP
  adapter creates is there, reading
  `"kind":"interactive"`, `"peerProtocol":1`, `"entrypoint":"sdk-ts"` —
  so an SDK-hosted session does register itself as a peer.
- The CLI the SDK bundles and spawns knows all about the feature:
  `remoteControlAtStartup`, `disableRemoteControl` and `remote-control`
  all appear in the binary.
- The adapter forwards `_meta.claudeCode.options` to the SDK, and that
  includes `settings`, so Mota can hand a session its own settings
  without touching `~/.claude/settings.json`. It also defaults to
  `settingSources: ["user", "project", "local"]`, so the user's own
  settings are loaded either way.

Every ingredient looked present. Before building anything on that, the
adapter was driven directly over stdio, exactly the way `acp_session`
does it.

## What the spike found

Three runs against `@agentclientprotocol/claude-agent-acp` 0.64.2:

1. `session/new` with
   `_meta.claudeCode.options.settings = { remoteControlAtStartup: true }`
   is **accepted** — no error, session created, and it registers in
   `~/.claude/sessions/` as above.
2. The registry entry carries **no remote-control marker**, and with
   `debug: true` and `CLAUDE_CODE_FORCE_BRIDGE=1` set on the adapter
   process, **stderr says nothing** about a bridge, daemon or peer
   connection. No background service appears.
3. Decisively: the session advertises **58 slash commands**, and
   `/remote` is not one of them. `/compact`, `/init`, `/review`,
   `/usage`, `/insights` and the rest all are, so the list is real and
   complete. The only near-match is an internal `__remote-workflow`,
   which is something else.

Remote Control is a property of the interactive REPL, not of a session.
Hosting the SDK gets the agent, not the harness around it — the same
shape as ADR-0011's finding about scheduling, and the opposite outcome:
there, the capability really was reaching the last mile and being
dropped; here it never starts.

## Decision

**Do not implement `/remote`, and do not build a remote surface of our
own.**

A Mota-owned control surface — an HTTP or websocket server in Rust, a
phone-facing UI, authentication, tunnelling — would mean new Cargo
dependencies, a change to the strict CSP in `tauri.conf.json`, a change
to `capabilities/default.json`, and a security surface out of all
proportion to the app. "Lightweight and fast is the product" rules it
out on its own; the fact that the same effort buys something claude.ai
already does rules it out twice.

No `/remote` command is registered. Typing it reaches the agent as
ordinary text and does nothing, which is what it did before.

## Consequences

- Driving a Mota session from a phone is not available, and will not be
  until the adapter grows a way in.
- Nothing was built that would have to be unbuilt. The plumbing this
  would have needed — `_meta` on `session/new`, a `remote` field on
  `SessionSpec` to force a respawn — is not there.
- If the adapter later exposes the bridge, the receiving half is already
  built and has been since ADR-0011: the agent-initiated lane renders
  work Mota did not start, permission requests included, which is
  exactly what a prompt typed on a phone would arrive as.

## The alternative, if this is wanted anyway

A **hand-off**: `/remote` ends the ACP session and launches
`claude --resume <sessionId> --remote-control` in Mota's terminal, with
the tab showing a handed-off state and `session/load`ing the
conversation back on return. It works because it uses the REPL rather
than trying to reach around it, and Mota already has both halves (a
terminal, and `sign_in.rs`'s pattern for launching a vendor CLI).

The cost is that Mota's UI is not the one driving while it lasts. That
is a product decision, not a technical one, and it is deliberately left
open rather than settled here.
