# ADR-0024 — Executing a plan in a fresh session, on a model the user picks

- Status: accepted
- Date: 2026-09-21
- Relates to: ADR-0004 (modes and permissions — why the mode and the
  permission are the app's to set), ADR-0005 (ACP sessions — why model and
  effort are spawn-time and a switch means a respawn), ADR-0022 (the other
  option Mota puts on a plan card)

## Context

A plan approval is the one card where the user's real question often is not
one the agent asked. The model that writes a good plan is frequently not
the one you want executing it: planning rewards breadth and care, execution
rewards throughput. And a plan is the one artifact that makes the swap
possible — it was written to be self-contained, so the agent carrying it
out needs none of the conversation that produced it.

Doing this by hand took five steps: decline the plan, open the plan panel
and copy the markdown, change the model picker (which **defers**
mid-conversation, so the change silently does not apply yet), start a new
chat, paste. The deferral is the part that bites: the user switches the
model, starts a new chat, and gets the model they picked — but only because
`chat/sessionReset` happens to fold the deferral in. Anyone reasoning about
it from the UI has no way to know that.

## Decision

A checkbox on every plan card that carries plan text — *Execute this plan
in a fresh session* — revealing provider, model, effort and permission
pickers and one confirm button. `ExecutePlanInFreshSession` then does, in
this order:

1. **Guards `tab.busy` itself.** Being parked on a plan already means
   `busy: false`, and `declineParkedPlan` clears it — but only when there
   is a card left to decline. Trusting that would let a stale card under a
   live turn wipe the conversation out from under it.
2. **Captures the plan first**, from the card or, failing that, from
   `tab.planMarkdown`. `chat/cleared` destroys both copies.
3. **Declines the plan and stops the planning agent**, reusing
   `declineParkedPlan`. Not approved-then-stopped: an agent that starts
   implementing while the handoff is being set up is a second agent working
   the same repository, and the race is unobservable from here.
4. **Ends the outgoing session** (`endConversation`, extracted from
   `startNewChat`) — before the provider changes, so the right provider's
   resume id is the one dropped.
5. **Writes the chosen spec straight to the tab**, after that reset.
6. **Persists**, then **starts the turn** with `executePlanPrompt(plan)`.

Three of those choices deserve their reasons stated:

- **The model change is applied, not deferred.** `SelectModel` defers
  mid-conversation because a respawn re-ingests the whole context at
  cache-write rates. Here the conversation is being thrown away, so that
  cost does not exist and the deferral would only produce a tab whose
  pickers disagree with the agent that is running. The spec is dispatched
  *after* `chat/sessionReset`, because that reset applies any earlier
  deferral — reversed, a model the user abandoned ten turns ago would win.
- **The mode is forced out of Plan** (`executingMode`). Mode is a per-turn
  field and `MODE_ENFORCES` makes Plan and Ask read-only at the agent's own
  tooling, so a fresh session on a plan-mode tab would plan the plan again
  and could not have implemented it if it tried.
- **Permission is a picker, not an elevation.** A fresh session inheriting
  Manual stops to ask on the first edit, which partly defeats "go execute
  this". But raising it silently is a security decision the user did not
  make. The panel therefore asks, starting on what the tab is already set
  to — so confirming without touching anything changes nothing but the
  session.

No warm-up is issued: the turn is the warm-up, and adding one would spawn
two agents for the new provider.

## Consequences

- **Same tab, so the planning transcript is gone.** That was the explicit
  choice: two tabs on one folder are two agents a user has to keep track
  of, and the transcript is still in History. What carries over is the
  plan, which is the whole point — it arrives as the fresh session's first
  user message, visible as such.
- **The plan is re-sent as text, not resumed.** There is no cross-vendor
  session to resume, and even same-vendor resume would bring back the
  conversation the handoff exists to shed.
- **A provider that is not installed or signed in fails inside the turn**,
  where it already does, with the transcript's sign-in affordance. By then
  the old conversation is gone. Pre-flighting was rejected: `DiscoverModels`
  only probes Codex, so the check would be a promise the app cannot keep
  for two of three providers.
- **Codex's model list is fetched on demand** from the panel, because the
  tab may never have run the provider being picked. `DiscoverModels` is
  idempotent and memoized per app run, so switching back and forth is free.
- **The agent's own option buttons are disabled while the box is checked**,
  not hidden. "Accept edits here" and "hand this to another model" are
  contradictory answers, but the card must still show what the agent
  offered.
- **The checkbox dies with the card.** Once the turn resolves or is
  cancelled, `answered` is true and the whole block unmounts — offering a
  handoff from a card the agent no longer holds would decline a request
  that no longer exists.

## Alternatives considered

- **A new tab, keeping the planning tab alive.** Preserves the transcript,
  but leaves two tabs on one folder and an idle planning agent the user
  must remember to close. Rejected in favour of History being the place old
  conversations live.
- **Approve the plan, then switch.** Would let the planning agent start
  work in the seconds before the switch lands. Declining is what typing
  over a plan already does, and it is the honest answer: the user is not
  saying "go ahead" to *this* agent.
- **Reuse `SelectProvider`/`SelectModel`/`SelectEffort`/`SelectPermission`.**
  Four use cases, one deferred model, three agent respawns and four
  workspace saves for a session that is about to be replaced anyway.
- **Map the plan card's chosen mode-switch option onto the tab's
  permission.** Clever, but nothing to map: in this flow the user never
  clicks one of the agent's buttons.
