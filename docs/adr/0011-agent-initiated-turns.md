# ADR-0011 — Agent-initiated turns

- Status: accepted
- Date: 2026-08-10
- Extends: ADR-0005 (interactive agent sessions over ACP)

## Context

An agent asked to "check CI and tell me when it finishes" would say it
would, and then never come back. The same request works in the Claude
Code VS Code extension, so the gap looked like a missing feature. It was
not one — it was a dropped event.

What the evidence says:

- The VS Code extension bundles `@anthropic-ai/claude-agent-sdk` and
  spawns the native `claude` binary with `--input-format stream-json
  --output-format stream-json`. It contains no scheduler of its own:
  `ScheduleWakeup` and `CronCreate` appear zero times in its bundle and
  many times inside the `claude` binary. The harness does the
  scheduling; the editor is a viewer.
- The ACP adapter Mota launches,
  `@agentclientprotocol/claude-agent-acp`, is powered by the same SDK,
  spawns the same binary, and exposes the same `claude_code` tool
  preset. It has explicit support for work the agent starts on its own —
  an `AUTONOMOUS_RESULT_ORIGINS` set covering `task-notification`,
  `peer`, `coordinator`, `observer` — and emits that work as ACP
  `session/update` notifications outside any prompt turn.
- Mota's Rust shell already passed them through: the stdout reader lives
  as long as the session, not the turn, and `handle_line` emits
  `Incoming::Updates` without consulting `turn_active`.
- The frontend then threw them away. `TauriAgentGateway` deleted a tab's
  turn handler on `completed`, after which only `sessionStage`,
  `modeChanged` and `notice` were forwarded and everything else dropped
  as a stray. Assistant text, tool calls and permission requests from a
  follow-up cycle all landed in that branch.

So the capability reached the last mile and died there.

## Decision

A tab has **two** inbound lanes, and the gateway decides which by asking
one question: is a turn of ours in flight?

- **Turn lane** — unchanged. `startTurn` registers a per-tab handler;
  `completed` retires it. Cancellation filtering and the superseded-turn
  generation guard live here and stay exactly as they were.
- **Agent-initiated lane** — new. `AgentGateway.subscribeAgentInitiated`
  takes everything else, and `SendPrompt` subscribes to it in its
  constructor. The events run through the *same* handling as a turn's,
  because to a reader they are the same thing: the agent talking.

Session-level events keep their own subscriber (`SessionStatus`) ahead
of the new lane, so warm-up stages and respawn notices are unchanged.

A history replay streams through both a temporary listener and the
process-wide one, so `loadNativeSession` marks the tab replaying and the
agent-initiated lane stands down for the duration. Without that, every
replayed message would land in the live chat a second time.

### Ending a cycle nobody started

ACP reports a stop reason for a prompt, and a follow-up answers none —
there is no completion event to wait for. The tab still goes **busy**
while one runs, because the agent really is working and Stop has to be
reachable; the flag comes down after `FOLLOWUP_SETTLE_MS` (2s) of
quiet instead of on a completion that is never coming. On settling, the
tab is released, anything the user queued behind it is delivered, and —
if the stretch was more than token-usage bookkeeping — the transcript is
saved and the user's attention is asked for.

Two guards keep that timer from doing damage: a settle that finds a real
turn in flight (`inflight.has(tabId)`) does nothing at all, and a
stretch with nothing user-visible in it notifies nobody.

Stop works because it always did: `acp_session::cancel_turn` sends
`session/cancel` and releases pending cards whether or not a turn is
tracked, and `stopTurn` clears busy itself.

## Consequences

- "I'll check back when CI is done" now arrives. So does anything else
  the agent does between turns, including approvals it needs — those
  were previously dropped, which meant an autonomous cycle asking
  permission hung with nothing on screen.
- The fix is frontend-only. No Rust, no protocol change, no new
  dependency: the events were already crossing the process boundary.
- The 2s settle is a heuristic, and it is the honest cost of a protocol
  with no out-of-turn idle signal. A follow-up that pauses longer than
  that mid-cycle will let the tab go idle and then take it busy again.
  Visible, self-correcting, and preferable to a busy flag with nothing
  to bring it down.
- A stop during a follow-up can still be trailed by a few events, which
  re-open a stretch for up to 2s. Same shape as a cancelled turn's tail,
  and bounded the same way.
- Mota gains nothing to schedule *with* — the scheduling lives in the
  agent's own harness, which is the right place for it. Should we ever
  want Mota to trigger work itself, this lane is what it would deliver
  through.
