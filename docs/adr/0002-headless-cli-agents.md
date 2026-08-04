# ADR-0002 — Chat UI over headless vendor CLIs

- Status: accepted
- Date: 2026-08-04

## Context

The product experience is a chat panel per project (like Cursor or VS
Code's agent view), not an embedded terminal. It must work with Claude,
ChatGPT, and Gemini. Building our own agentic loop against each vendor's
HTTP API would mean re-implementing tool use, file editing, permission
prompts, context management, and auth — three times, on three moving
targets.

## Decision

v1 produces answers by running each vendor's **official CLI in headless
mode**, with the project folder as working directory:

- Claude Code: `claude -p <prompt> --output-format stream-json --verbose
  [--resume <session>]`
- Codex (ChatGPT): `codex exec [resume <session>] --json <prompt>`
- Gemini CLI: `gemini -p <prompt> --output-format json`

The chat UI never knows this. The frontend depends on the `AgentGateway`
port; the Rust side depends on the `Provider` trait. CLIs are an adapter
detail.

## Consequences

- Sign-in, model selection, sandboxing, and tool permissions are inherited
  from each CLI — users authenticate once per vendor, in their terminal.
- Conversation continuity uses each provider's own session id, persisted
  per project per provider. Gemini's non-interactive mode has no resume;
  its descriptor says so (`supportsResume: false`) and the UI simply
  doesn't promise it.
- Vendor CLIs drift. All knowledge of a vendor's flags and stream format
  is confined to one file per vendor in `agent-core/src/providers/`;
  unknown lines are ignored, so drift degrades output detail, not the app.
- A direct-API adapter (or any future agent runtime) can be added behind
  the same port without touching a use case — this decision is
  deliberately reversible at the boundary.
- Cost accepted: no token-by-token streaming inside a message in v1;
  granularity is per assistant message / tool step, which the stream
  formats provide.
