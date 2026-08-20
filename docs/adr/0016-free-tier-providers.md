# ADR-0016 — Free-tier providers, and agents that configure themselves by flag

- Status: accepted
- Date: 2026-08-20
- Extends: ADR-0002 (headless CLI agents), ADR-0005 (ACP sessions)

## Context

The three providers the workbench drove — Claude, Codex, Gemini — are all
paid. When a plan is spent, the editor stops being an editor until the
quota resets. That is the whole motivation: a workbench that goes dark on
the 20th of the month is not a workbench.

Two agents change that, and both already speak ACP:

- **opencode** (`opencode acp`) serves the OpenCode Zen gateway, whose
  lineup includes several models at no charge. Verified 2026-08-20: a
  turn completes on `opencode/big-pickle` with **zero credentials
  configured** — no sign-in at all.
- **cline** (`cline --acp`) runs against a Cline account, which carries a
  free tier.

Adding them turned up three things the existing design did not cover.

**1. `provider_for` gates the turn before ACP is reached.**
`commands.rs::start_turn` resolves the `Provider` trait object at its
first line and returns `Unknown provider` if there is none; the ACP
attempt is thirty lines below. An "ACP-only" provider is therefore not
expressible, so both new providers need a headless adapter — even though
in practice it runs only against an outdated install, because these two
ship ACP in the same binary the user already has.

**2. Model ids can contain a slash.** opencode names models
`vendor/model`. `validate_token` allowed `[A-Za-z0-9._\-:]`, so every
opencode turn would have failed before a process was spawned.

**3. Not every agent takes its model from the environment.** Claude,
Codex and Gemini read env vars. `opencode acp` accepts no model flag at
all — given one it prints its help and never starts the server — while
cline takes `--model` and `--thinking` as top-level flags beside `--acp`.

## Decision

**Model selection follows the agent, not a house style.** `acp::agent_env`
gains an opencode arm that writes `OPENCODE_CONFIG_CONTENT` — an inline
config blob opencode merges over its resolved configuration at startup,
the same shape as the existing `CODEX_CONFIG`. A new sibling,
`acp::agent_args(provider_id, model, effort)`, returns argv that
`spawn_agent` appends after the launch candidate's own args; only cline
returns anything. Both are pure functions in `agent-core` and both are
keyed off `SessionShape`, which already includes model and effort, so a
change to either respawns the tab's agent as before.

`agent_args` rather than widening `agent_commands`: the latter is a
static table that `provider_probe` reads for an install hint with no
model in hand, and giving it selector parameters would force a
`(None, None)` call that lies about its inputs.

**`validate_token` accepts `/` and rejects a leading `-`.** The slash is
safe because the value only ever becomes an env-var value or one argv
element, and `runner::os_command` passes an argv vector to an absolute
program, never a shell. The leading-dash rejection is new and closes a
pre-existing gap: a "model" starting with `-` would be read as a flag by
whatever CLI it was appended to.

**Headless adapters are written from captured output, or not written.**
Both adapters were built against output captured from the installed CLIs
(opencode 1.18.19, cline 3.0.55) and their tests embed those exact lines.
Where a shape was not captured it is not parsed: cline's incremental
event names are unknown, so only its terminal `done` event is read, and
anything unrecognised falls through to a plain-text reading of stdout
rather than a guessed schema that would swallow the reply the day it
drifted.

**Cline's auto-approval is always stated explicitly.** The CLI defaults
`--auto-approve` to `true`. Inheriting that would let a tab set to Manual
act unattended on the one path that has no way to ask, so the adapter
passes the flag on every invocation and only `Permission::Bypass`
produces `true`.

**Cline offers no model suggestions.** `cline auth` both signs the
account in and chooses its model, and the account's catalogue is not
readable without those credentials. `MODEL_SUGGESTIONS.cline` is
therefore empty and every cost preset asks for the provider default —
guessed ids would populate a picker with entries that fail only once the
user sends a prompt.

**Free is priced as zero; unknown stays unknown.** `MODEL_PRICES` gains
`$0` rows scoped to Zen's own naming (`-free`, `big-pickle`), not to the
provider. A paid model the user routed through opencode has a price this
table does not know and falls through to "n/a". Cline gets no rows at
all. The distinction matters because `0` and `null` are both falsy in
JavaScript and mean opposite things — "cost nothing" versus "we have no
idea" — which is why the pricing tests assert `toBe(0)` rather than any
falsy check.

## Consequences

- Two providers whose free tiers keep the editor usable after a paid plan
  is spent. opencode in particular works with no account at all.
- Both advertise `loadSession` at the handshake, so both resume.
- The headless fallback for these two is reachable only when the
  installed CLI cannot complete an ACP handshake. On that path there is
  no streaming, no approval prompt, no tool row and no billing data —
  the existing "using basic mode" notice already says so.
- Zen's free lineup rotates faster than any vendor's model list, so
  `MODEL_SUGGESTIONS.opencode` will go stale sooner than its neighbours.
  A model missing from the list is still reachable: the picker keeps any
  value already chosen.
- The Providers settings screen now probes five agents rather than three.
  They are probed concurrently, so wall-clock is unchanged, but it is two
  more processes each time the screen opens.
