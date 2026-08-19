# ADR-0016 — A conversation has an identity, and a retired chat keeps its agent

- Status: accepted
- Date: 2026-08-19
- Extends: ADR-0011 (agent-initiated turns — the lane this addresses)
- Relates to: ADR-0005 (ACP sessions), ADR-0001 (lightweight is the product
  — what a second adapter process costs)

## Context

ADR-0011 delivered the turns an agent starts on its own: a watcher fires, a
background task finishes, a scheduled wake-up lands, and the events arrive
outside any prompt turn. It routed them by tab id, which is all the wire
carried.

Then the user starts a new chat. The tab id has not changed — it names the
tab for its whole life — so the follow-up lands in the conversation that
replaced the one that asked for it. Two things were wrong at once:

**Nothing said which conversation an event was for.** `runner::emit` sent
`{ tab_id, event }`; ACP's own `params.sessionId` was parsed and dropped in
`agent_core::acp::parse_incoming`; `spawn_reader` baked the tab id into its
closure at boot and went on emitting under it for the life of the process.
The frontend's three lanes all keyed on that one id. `tab.busy` was the only
interlock, and it has holes by design — a follow-up cycle that pauses longer
than `FOLLOWUP_SETTLE_MS` lets the tab go idle while the agent is still
working, which ADR-0011 records as an accepted cost.

**And the report could not have arrived anyway.** `end_session` killed the
agent process, so a watcher that fired after "New chat" was simply dead. The
feature reached the last mile a second time.

## Decision

**A conversation gets an identity, and it crosses the process boundary.**
`TabState.chatId` is minted by the reducer — `tabId#n`, re-minted by
`chat/sessionReset`, the one action that already means "this is a different
conversation now". It travels on every call that boots, reuses or prompts a
session, `AcpSession` holds it, and `runner::emit_for` stamps it on
everything that session emits. The frontend's three lanes drop what is not
the tab's current chat.

The frontend is authoritative: a session reused by `ensure_session` **adopts**
the caller's chat id. Without that, a webview reload — which mints fresh ids
for tabs whose backend sessions survived, every hot reload in development —
would have every event from those sessions dropped.

An event with no chat id belongs to whatever chat is current. That covers the
transport-level failures and the rows this app writes itself, and it is why
nothing regresses if a path is missed.

**"New chat" retires the agent instead of killing it.** `retire_for_new_chat`
parks the session in `AcpSessions::retired` — still reading its stdout, still
emitting under the chat id it was booted with. One per tab: retiring again
ends the previous one, which is what bounds a tab to two adapter processes.
`end_session` keeps its kill semantics for the paths that mean it (tab
closed, app quitting) and drains the retired slot too.

**A retired chat is a transcript being finished, not a view.** `RetiredChats`
captures the conversation before the clear, folds the agent's late words into
it, and rewrites the History row that chat already had — so the answer lands
next to the question instead of forking a copy. Nothing touches `AppState`:
the chat is off screen by definition. On quiet (`FOLLOWUP_SETTLE_MS`, the same
rule the live lane uses) it saves, raises one notification, and ends the
agent. With nothing said at all it is let go at `RETIRED_IDLE_LIMIT_MS` (10
minutes) — silently, because the transcript on disk is already right.

The fold is deliberately narrower than the live chat's. A cycle nobody
prompted says things, thinks, runs tools and fails; what it cannot do off
screen is be answered, so an approval or a question becomes a line saying it
went unanswered rather than a card with buttons nothing would deliver.

### What "New chat" had to stop doing on its way out

Found while tracing the same bug, each able to leak the old conversation into
the new one on its own — and each now closed by the chat id rather than by a
new interlock:

- A buffered delta flushing after the clear appended the old agent's text to
  the fresh chat. The buffer records the chat it was streamed into; a stale
  one is dropped, losing at most one flush interval of a conversation the
  user just walked away from.
- An open follow-up's settle timer released the busy flag, drained the queue
  and saved the transcript — of the wrong chat.
- A completion's outcome was stamped onto a prompt that no longer existed.
- The gateway's per-tab turn handler outlived the session it was listening
  to; `endSession` and `retireSession` drop it, as `loadNativeSession`
  already did.
- A plan-parked turn is idle on screen and **open** on the agent's side.
  Retiring underneath it left the agent waiting on an answer nobody could
  give, and its "agent process ended unexpectedly" landed in the new chat.
  `startNewChat` now declines the plan first, as sending a prompt already did.
- A prompt queued behind the old conversation drained into the new one. It
  was written for the chat above it; delivering it to an agent that has never
  seen that chat asks a stranger to finish somebody else's sentence.

## Consequences

- A tab can hold two agent processes: the live one and at most one retired.
  That is the price of the feature, and it is why the ceiling exists.
- A webview reload forgets the frontend's settle timers, so a retired agent
  survives until the next "New chat" in that tab, the tab closing, or the app
  quitting. Bounded to one process per tab, and dev-only in practice.
- The notification is the only thing that reaches the user in the moment; the
  chat on screen is left completely alone, which is the whole point.
- `agent_core` is untouched. The identity is Mota's idea about its own tabs,
  not a protocol concept — ACP's `sessionId` names the agent's session, which
  can change under one conversation (a resume) and outlive another.
- Two commands join the surface (`retire_session`, `discard_retired`) and
  `emit` grows a chat-aware sibling. No new dependency, no protocol change.
