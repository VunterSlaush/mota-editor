# ADR-0004 — Modes and permissions over headless CLIs

- Status: accepted
- Date: 2026-08-04

## Context

Users choose, per tab, a **mode** (agent / plan / debug) and a
**permission policy** (manual approval / bypass permissions). The agents
run as non-interactive CLI processes (ADR-0002), which constrains how
faithfully each combination can be enforced.

## Decision

Mode and permission are domain concepts (`agent-core::turn`); each
provider adapter maps them to the closest native capability, falling back
to a strict prompt preamble:

| | Claude | Codex | Gemini |
|---|---|---|---|
| Plan | native `--permission-mode plan` | preamble + `--sandbox read-only` | preamble |
| Debug | preamble | preamble | preamble |
| Manual approval | CLI default (risky actions denied) | default sandbox | default approvals |
| Bypass | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--yolo` |

Composition rules, unit-tested in `turn.rs` and the provider adapters:
plan mode wins over bypass for Claude **and Codex** (a plan never writes,
so the bypass flag would only add risk); debug is always a preamble; the
preamble is prepended before the attachment note and user prompt.

Enforcement strength, stated plainly: plan is **mechanical** on Claude
(native) and Codex (read-only sandbox), **advisory** (preamble) on Gemini
when combined with bypass; debug is advisory everywhere by nature — no
CLI has a debug concept.

## Consequences

- "Manual approval" in a headless run means **denied-by-default**, not an
  interactive prompt — the CLI cannot ask through a pipe. True in-chat
  approval is future work behind the same `AgentGateway` port and requires
  moving from one-shot CLI runs to a persistent protocol session per
  provider: Claude Code's `--permission-prompt-tool` (an MCP tool the CLI
  calls to request approval, which the UI answers), Codex's JSON-RPC
  app-server mode (emits approval requests), or the Agent Client Protocol
  (ACP) which Claude and Gemini already speak and which unifies
  permission-request/response for chat clients like this one. The UI
  wording ("Safe defaults…") is honest about today's behavior.
- Preamble-based modes are advisory for the model but combined with
  manual permission they are also mechanically safe (the sandbox denies
  writes anyway). Plan mode + bypass on Codex/Gemini relies on the
  preamble alone — documented trade-off.
- Mode/permission travel per turn in the `TurnRequest` DTO, so changing
  them mid-conversation affects the next turn only, which matches user
  expectation.
