# ADR-0018 — Slash commands in sub-agents

- Status: accepted
- Date: 2026-08-24

## Context

A `CommandConfig` (ADR-less, see `src/core/entities/commandConfig.ts`) can already pin
mode, permission, model and effort per `provider:command`. Two of those four do not work.

`ApplyCommandConfig` returns before applying model or effort once the tab has a provider
session, and it is right to: both are spawn-time over ACP — they are part of `SessionShape`
(`acp_session.rs`), so changing either retires the agent. `SelectModel` defers for the same
reason, and states the real cost: *"the prompt cache is keyed per model, a model change pays
for all of it at cache-write rates."* So pinning `/commit-push` to sonnet does nothing in
any conversation that has started, and making it work anyway would cost more than it saves
— roughly −$0.65 per run at a 180k context, plus leaving the tab on the wrong model.

Measured from this machine's vendor logs (455 files, 31,161 deduped billed requests, priced
with `modelPricing.ts`), the bigger problem is not the model at all:

- Cache reads are **98.3%** of main-thread tokens; the median request re-reads **180k**.
- A turn past 100 costs **2.5x** one in the first ten, and half of all requests are past it.
- `/commit-push` over 65 runs adds **28,291 tokens** to the conversation, and **132.6**
  requests follow it in the same session — each re-reading those tokens.

That residue is ~$1.88 per run against ~$1.28 for the run itself. A sub-agent removes it:
the child's tool output never enters the parent transcript. Isolation is worth ~$2.38/run;
the model swap on top adds ~$0.20. **~92% of the saving has nothing to do with the model.**

## Decision

- A command config gains **`agent?: string`** — the name of a sub-agent to hand the command
  to. Absent means "run in this chat", which stays the default for every command.
- **Mota implements no sub-agent runtime and writes no definitions.** All three providers
  ship the primitive (Claude `.claude/agents`, Codex `.codex/agents`, Gemini
  `.gemini/agents`) with their own built-ins. Mota discovers what is already there,
  read-only, and points at it.
- **Vendor syntax lives in `agent-core`**, in `delegate.rs`, next to `agent_env` and
  `scope_preamble`. The domain decides *that* a command is delegated and *to whom*; the
  translation layer decides how to say it. `SendPrompt` never branches on provider.
- Composed by **both** prompt paths — `acp::prompt_request_for_provider` and
  `turn::effective_prompt` — for the reason ADR-0014 gives for the scope preamble: a
  command configured to run in a sub-agent must not quietly run inline on a machine that
  falls back to headless.
- The child starts fresh but receives a **bounded hand-off** (`entities/handoff.ts`): the
  most recent user/assistant messages, capped at ~2k tokens. Without it, "commit this as
  the fix for the bug we just found" hands a pronoun to an agent with no referent.
- **Failure is loud and happens before anything is spent.** If the configured agent is not
  in the discovered list, nothing is sent and the transcript says so.
- The delegation is **announced in the transcript** with an info row.

## Consequences

- The model and effort pins finally mean something: a sub-agent is a fresh child, so
  whatever its definition pins applies with no conversation to re-ingest and no cache to
  rebuild. The lever that was inert becomes real — by moving the work, not the setting.
- Users author their own agents. Mota does not offer to write one (yet), so the full
  `/commit-push`-on-sonnet-at-medium-effort case needs a definition file the user creates.
  In exchange Mota owns nothing on their disk and cannot leave anything behind.
- Codex is advisory. It has no mention grammar, so its delegation is prose naming the
  agent; Claude and Gemini expand `@` mentions mechanically.
- A sub-agent's report arrives as a tool row, which the transcript hides while Verbose is
  off — hence the info row, without which a delegated turn would look like it did nothing.

## Alternatives rejected

**Make the mid-conversation model pin work.** Cost-negative, per the arithmetic above, and
it leaves the tab on the command's model afterwards.

**A Mota-managed hidden ACP session** under a synthetic id (`cmd:<uuid>`), streaming into
the current tab. Provider-agnostic and fully under our control, but `session/new` is tens
of seconds (~50s measured here) and each adapter is a 100–300 MB Node process. Worse, the
transcript's approval, question and terminal cards carry **no owner id**: `App.tsx` answers
every one against the *active tab*, so a child's permission request would be answered on
the parent's session — cross-session response injection, not a dropped click. Terminal ids
collide the same way (per-manager `term-N` counters). The owner-id refactor is the real
prerequisite, and it is not this change. If delegation ever proves unreliable, the shape to
extend is `ask_once` (`acp_session.rs`), which is deliberately never registered in
`sessions.map` — that single property is what makes the hazard list evaporate.

**Mota generating agent definitions** into `~/.claude/agents` and friends. Mota reads those
folders in five places today and writes to none; the only precedent for touching user-scope
config is the extension grant table, which has one owner module and a native consent dialog.
A definition Mota wrote would also show up in the user's plain CLI sessions forever, with no
uninstall path.

**Pinning model and effort inline, with no definition at all.** Verified impossible: Claude's
`Agent` tool takes a model but has no effort parameter, Codex removed inline model and
reasoning in 5.6, and Gemini never documented either.

## Verified, not assumed

- A slash command is **not** expanded inside a sub-agent — probed with
  `claude -p '@"Explore (agent)" … /xyzzy-not-real'`, which replied `LITERAL`. The
  delegation therefore names the command and tells the child to go and read its definition.
- Claude's mention expander matches
  `(^|[\s。、？！])@"([\w:.@-]+) \(agent\)"` — start-of-string or whitespace, exactly one
  space before `(agent)`, and no `/` in the name. That regex is copied into
  `subagent.test.ts` as the contract, and an unaddressable name is refused rather than sent.
- An unresolved mention is dropped **silently**, which is why the existence check is
  pre-flight rather than after the fact.
