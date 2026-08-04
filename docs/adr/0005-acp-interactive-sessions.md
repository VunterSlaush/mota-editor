# ADR-0005 — Interactive agent sessions over the Agent Client Protocol

- Status: accepted
- Date: 2026-08-04
- Supersedes: the "manual approval = denied-by-default" limitation of
  ADR-0004 (that behavior remains only in the fallback path).

## Context

One-shot headless CLI runs (ADR-0002) cannot ask the user anything: a
pipe has no way to prompt, so "manual approval" degraded to
denied-by-default. We want real in-chat approval — the agent asks, the
user clicks Allow or Deny — plus streamed responses.

## Decision

The primary transport is now a **persistent Agent Client Protocol (ACP)
session per tab** — JSON-RPC 2.0, newline-delimited, over the agent
process's stdio (protocolVersion 1, <https://agentclientprotocol.com>).
One protocol serves all three vendors:

| Provider | ACP agent | Launch |
|---|---|---|
| Claude | claude-agent-acp adapter | `npx -y @agentclientprotocol/claude-agent-acp` |
| ChatGPT (Codex) | codex-acp adapter | `npx -y @agentclientprotocol/codex-acp` |
| Gemini | native | `gemini --acp` |

Layering follows the house rules: `agent-core::acp` is the pure protocol
core (message building, incoming-line classification, translation to
`AgentEvent`, bypass-choice policy — all unit-tested);
`src-tauri/src/acp_session.rs` is the mechanical shell (spawn, route
ids, respond). The frontend still sees only the `AgentGateway` port,
extended with `respondPermission` and `endSession`.

Key mappings:

- **Manual approval** → the agent's `session/request_permission` request
  is surfaced as an approval card in the chat; the user's choice is sent
  back verbatim (`optionId` is opaque; `kind` is only a UI hint).
  Unanswered requests are answered `cancelled` when the turn is
  cancelled, per spec.
- **Bypass permissions** → the client auto-selects a one-time allow
  option on every request — mechanical, uniform across vendors.
- **Modes** → native session modes where they exist
  (`session/set_mode`: Claude `plan`/`default`, Codex
  `read-only`/`agent`), preamble otherwise; best-effort, failure never
  blocks a turn.
- **Streaming** → `agent_message_chunk` updates become token-level
  deltas in the chat; `tool_call` updates become tool rows.
- **Attachments** → baseline `resource_link` content blocks (file:// URIs).
- The client declares `fs` and `terminal` capabilities false, so agents
  do their own file I/O; any unexpected agent→client method gets a
  `-32601` response.

**Fallback:** if the ACP agent can't be launched (adapter not installed,
binary missing, handshake timeout), the tab falls back automatically to
the ADR-0002 one-shot headless path for that turn, with an info row
explaining what to install. ADR-0004 semantics apply there.

Verified live against `@agentclientprotocol/claude-agent-acp`:
initialize/session-new handshake, streamed chunks, a real permission
request (Deny honored — the write never happened), and `end_turn`.

## Consequences

- "Manual approval" now means what it says on any machine with the ACP
  agent available; sessions also persist across turns in-process, which
  improves conversational continuity beyond the old resume-id approach.
- Two transports must coexist. The cost is contained: they meet only in
  `commands.rs::start_turn`, and both feed the same `AgentEvent` stream.
- `npx -y` may download an adapter on first use (the handshake timeout
  is generous for that reason); users can `npm i -g` the adapters to
  make startup instant.
- Adapter packages are pinned by name, not version; ACP's versioned
  protocol (integer 1) and ignore-unknown-updates rule are the drift
  protection.
