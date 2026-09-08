# ADR-0022 — A bypass option on every plan card, supplied by Mota

- Status: accepted
- Date: 2026-09-08
- Relates to: ADR-0004 (modes and permissions — bypass is the app's policy,
  which is what makes this possible), ADR-0005 (ACP sessions — the option
  ids this adds to and translates back out of), ADR-0014 (subtasks — whose
  scope stays the ceiling this cannot lift)

## Context

Approving a plan is the one permission request that always reaches the
user, even under bypass (`is_plan_approval`). The card the user answers is
built by the *agent's adapter*, and every adapter offers exactly one
elevated way to say yes:

- `claude-agent-acp` (`buildExitPlanModePermissionOptions`) ranks
  `auto` above `bypassPermissions` above `acceptEdits`, and `auto` is in
  `buildAvailableModes()` unconditionally while `bypassPermissions` is
  gated. `exit-plan-bypass` is therefore unreachable in practice: a plan
  card offers auto or nothing.
- `codex-acp` offers `implement_plan` / `revise_plan` and has no elevated
  option at all.

So a user whose tab is set to Bypass would approve a plan and then be
asked about every edit for the rest of the turn — the card had taken the
choice away, and the app had no way to give it back. `exit-plan-bypass`
stayed in the hint table and in `is_plan_approval` describing an option
that never arrives.

Waiting for the adapters is not a fix: which elevated mode a plan card
carries is their vocabulary and it has already moved twice (0.73 renamed
the whole set, 0.75 made auto unconditional).

## Decision

- **Mota adds the option itself.** `acp::with_plan_bypass_option` appends
  "Yes, and bypass permissions" to every plan approval that does not
  already carry one, positioned last among the yeses so the decline keeps
  the bottom of the card and the agent's own recommendation keeps the top.
  A card the agent *did* put a bypass on is passed through untouched — two
  buttons meaning the same thing is a worse card than the one that was
  missing a button.
- **This is honest because bypass is ours.** ADR-0004 made Bypass an app
  policy, not an agent mode: `native_mode_id` never asks Claude for
  `bypassPermissions`, and the session answers the requests itself
  (`bypass_choice`). Mota is not claiming a capability the agent has; it
  is offering the one it already implements, on the one card that had no
  way to reach it.
- **The plan is accepted through the agent's plainest yes.** The synthetic
  id is `mota-plan-bypass:<the agent's own option id>`, chosen by the same
  `bypass_choice` used everywhere else — a one-time allow when offered.
  The agent hears its most conservative accept: the plan starts, the
  context is not cleared, no agent-side mode is elevated, and Mota does
  the approving from there. The id carries its target because the answer
  travels back from the UI as an option id and nothing else;
  `respond_permission` sees the button, never the card.
- **Answering it changes this side only.** `respond_permission` translates
  the id back, sets the session bypassing, and clears `plan_mode` — the
  turn is no longer a planning one, and without that the auto-approval
  gate would keep asking. The tab's own permission moves to Bypass and is
  persisted, so the composer's picker tells the truth and the next turn
  starts where this one ended.
- **Layering.** Building the option and parsing it back is pure, tested
  logic in `agent_core::acp`; `acp_session` appends on emit and translates
  on answer; the frontend entity knows only the prefix (to explain the
  button and to notice the choice), and the UI renders the card it is
  given, as it always has.

## Consequences

- One id in the wire vocabulary is Mota's rather than an agent's. It never
  reaches an agent — `plan_bypass_target` strips it first — but it does
  reach the frontend, so `PermissionOptionInfo`'s "echo it back verbatim"
  contract now has one documented exception.
- Approving with it is a *durable* choice, exactly like picking Bypass in
  the composer: the tab stays bypassing until the user changes it back.
  That is the same promise the agent's own `exit-plan-bypass` made.
- A subtask scope caps what bypass means, and that cap is applied once, at
  turn start — this option arrives after it. So the card asks the scope
  again (`AcpSession::scope_permits_bypass`): a read-only or
  boundary-scoped tab is not offered the button, and an id arriving there
  anyway is answered as the plain accept it wraps. The scope stays the
  ceiling it was in ADR-0014.
- If an adapter ever ships a reachable bypass option again, the card
  silently goes back to the agent's own — no code change, no dead button.

## Alternatives considered

- **Patch the adapter.** It lives in an npx cache and is replaced on every
  version bump; the fix would evaporate, and Mota would be shipping a fork
  of someone else's protocol layer.
- **Ask the agent for `bypassPermissions` via `session/set_mode`.** Rejected
  by ADR-0004's reasoning: the app deliberately does not hand an agent a
  mode that turns off its own asking, because Mota's approvals are what
  the user sees and the transcript records.
- **Offer a "clear context and bypass" variant too.** The clearing is the
  larger, more destructive half of that pair and the agent still offers it
  for auto. One added button, doing one thing, is enough.
- **Let the composer's Bypass picker apply mid-turn instead.** A broader
  change to how live turns track their permission, and it would still
  leave the plan card without the button the user was looking for.
