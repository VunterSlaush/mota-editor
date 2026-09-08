# ADR-0023 — Command sequences

- Status: accepted
- Date: 2026-09-08

## Context

Every prompt is one turn. A workflow the user repeats — review, then write tests, then
commit — is three things to type, each waited on before the next can be started. Nothing
about that is a limitation of the agents: Mota already has both halves needed to automate
it.

- A per-tab prompt queue delivers messages in order as turns complete (`TabState.queued`,
  `SendPrompt.drainQueue`). Typing while the agent works already means "run this next".
- A slash-command palette already merges builtins, extension commands and discovered
  command files into one list (`paletteCommands`, `ListCommands`).

What is missing is a way to say "this name means those prompts, in that order".

## Decision

**Settings → Command Sequences.** A sequence is `{ id, name, description, steps }` where a
step is *any prompt line* — a slash command, plain prose, or both. Invoking it sends step
one immediately and unshifts steps 2..N onto the **front** of the tab's queue, so they fire
back to back as each turn completes. Sequences are global, not per provider: a workflow is
the user's, not the vendor's.

Steps go back through `SendPrompt.execute`, so per-command settings (ADR-0018's
`CommandConfig`, including sub-agent delegation) and extension commands keep working inside
a sequence. `$ARGUMENTS` reuses the existing `expandPromptCommand` contract, so what an
author already knows from Claude's custom commands transfers unchanged.

Three rules are worth writing down, because each of them is a decision a future reader
would otherwise relitigate.

### 1. Precedence: a sequence beats a command, except Mota's own

A sequence outranks an extension command and an agent-advertised command of the same name.
It loses to `MOTA_COMMANDS` — `/clear`, `/create-extension`, `/install-extension`,
`/update-extensions` — which `SendPrompt` handles above the sequence branch and which no
agent can supply.

Naming a sequence is the user saying what that name means from now on, which is why it wins
against everything that is merely *offered* to them. It cannot win against the four Mota
answers itself: those are decided before the sequence branch is reached, so allowing the
name would leave a setting that quietly does nothing. `isReservedSequenceName` refuses them
in one place, and the palette, the executor and the settings row all read it.

The rule is applied in three places that must agree — `ListCommands.forProvider`,
`paletteCommands` and `SendPrompt.execute` — which is the reason it is stated once here.

Accepted deliberately: a sequence named `/review` displaces the builtin `/review` row from
Settings → Commands. That is the honest reading of "the name means the sequence now". This
mirrors ADR-0012's extension-command shadowing, where the same trade was made for the same
reason.

A new `CommandSource` value, `"sequence"`, carries this. Tagging sequences `"builtin"` to
ride along with Mota's own would have been cheaper by one line and wrong: `paletteCommands`
drops every discovered builtin the running agent did not advertise, so a sequence would
have vanished from the palette the moment an ACP session came up.

### 2. Cycles are cut by flattening eagerly, not by guarding the recursion

`sequenceSteps` expands a whole sequence up front: nested sequences are spliced in place, a
step naming a sequence already on the path is dropped, and the result is capped at
`MAX_SEQUENCE_STEPS` (50). It **never returns a step that names another sequence** — a
property asserted over random sequence graphs, cyclic ones included.

The alternative — let `execute` recurse and count depth — cannot work here. Steps 2..N
re-enter `SendPrompt` through the queue as **provenance-free strings**: by the time one is
drained, nothing distinguishes it from a prompt the user typed. A self-referential `/ship`
would be an unbounded async loop that unshifts a fresh copy of its own steps every pass and
never yields to a turn, and no counter carried in a local variable would see it. Flattening
makes `execute`'s recursion provably one level deep.

This is the same shape of decision as ADR-0018: a command is not always what it says it is,
and the place to resolve that is before anything is sent, not while it is running.

### 3. Failure semantics are the queue's, unchanged

Nothing new is invented for what happens when a step goes wrong.

- **Stop discards the rest.** `stopTurn` already clears the queue and says how many messages
  it dropped; a sequence is no different from anything else waiting there.
- **A failed turn still drains the next step.** The queue has always worked that way, and a
  sequence that halted on the first hiccup would be less useful than typing the steps by
  hand.

Users who want a sequence to stop on failure say so in the step: the agents can read.

## Consequences

- `/ship` itself never becomes a user message. The transcript shows an info line naming the
  sequence and its step count, then step one's expanded text. `retryLast` therefore retries
  step one, not the sequence — defensible, and the info line says which sequence is running.
- `AppSettings.commandSequences` persists with the workspace, sanitized at restore by
  `restoredSequences`: a row that could not run is dropped rather than left in the palette
  answering nothing.
- The sequence branch sits **after** `declineParkedPlan` (which reaches `stopTurn` and would
  wipe the steps just queued) and **before** `applyCommandConfig` (which would otherwise look
  up a config for a token that never starts a turn, and could respawn the session for it).
  Both halves of that placement are load-bearing.
- Three pre-existing holes in the queue had to be closed in the same change, because a
  sequence turns them from rare into routine: `/clear`, a delegated command whose sub-agent
  is missing, and a turn that never started all returned without draining. A fourth, the
  auto-compact race, got its own commit — see `entities/autoCompact.ts`.

## Alternatives considered

- **A step list that bypasses `SendPrompt`.** Sending the steps straight to the gateway would
  have been simpler and would have silently dropped per-command settings, sub-agent
  delegation and extension commands inside a sequence — the three things that make a
  sequence worth more than a macro.
- **Per-provider sequences.** Rejected: `commandConfigs` is keyed per provider because
  `/review` means something different to each CLI, but a workflow is the user's own and the
  same in every tab. A global list also keeps the settings screen honest about that.
- **Appending the steps to the queue rather than unshifting them.** Queue `/ship` while busy,
  then queue `foo`: the sequence expands at drain time, and appending would give
  `[foo, step2, step3]` — the later prompt running in the middle of the workflow.
