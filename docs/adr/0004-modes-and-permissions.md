# ADR-0004 — Modes and permissions over headless CLIs

- Status: accepted
- Date: 2026-08-04
- Amended: 2026-08-14 — **Ask** joins the mode list (see below). The
  mapping table is a reference the adapters are read against, so it is
  amended in place rather than left to go stale.

## Context

Users choose, per tab, a **mode** (agent / plan / ask / debug) and a
**permission policy** (manual approval / bypass permissions). The agents
run as non-interactive CLI processes (ADR-0002), which constrains how
faithfully each combination can be enforced.

Ask exists because "what does this do?" is not "plan this". Both are
read-only, and plan mode was being used for both — which meant asking a
question got an implementation plan back, and a plan-approval prompt
after it.

## Decision

Mode and permission are domain concepts (`agent-core::turn`); each
provider adapter maps them to the closest native capability, falling back
to a strict prompt preamble:

| | Claude | Codex | Gemini |
|---|---|---|---|
| Plan | native `--permission-mode plan` | preamble + `--sandbox read-only` | preamble |
| Ask | preamble + `--permission-mode plan` | preamble + `--sandbox read-only` | preamble |
| Debug | preamble | preamble | preamble |
| Manual approval | CLI default (risky actions denied) | default sandbox | default approvals |
| Bypass | `--dangerously-skip-permissions` | `--dangerously-bypass-approvals-and-sandbox` | `--yolo` |

Ask takes plan's row and keeps its own preamble. No CLI has an ask
concept, but every read-only tier they do have is the one plan uses, and
"read anything, write nothing" is exactly what Ask needs from the tool
layer. What separates the two modes is entirely in the words — so unlike
plan, Ask's preamble survives the native mapping (`turn::mode_preamble`),
and it says outright that the prompt is a question rather than a request
for an implementation plan.

Composition rules, unit-tested in `turn.rs` and the provider adapters:
plan and ask both win over bypass for Claude **and Codex** (neither
writes, so the bypass flag would only add risk); debug and ask are always
preambles; the preamble is prepended before the attachment note and user
prompt.

Enforcement strength, stated plainly: plan and ask are **mechanical** on
Claude (native) and Codex (read-only sandbox), **advisory** (preamble) on
Gemini when combined with bypass; debug is advisory everywhere by nature
— no CLI has a debug concept.

One native mode id therefore covers two of ours, on both vendors. The
agent reporting its session mode (ACP `current_mode_update`) can only
name what it enforces, so `modeFromAgentModeId` is given the mode the tab
is already in and keeps it whenever the two agree — otherwise a session
announcing itself would drag every Ask tab into Plan. The same guard
fixes Debug, which a writable session had always been flipping to Agent.

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
