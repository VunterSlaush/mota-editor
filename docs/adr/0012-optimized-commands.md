# ADR-0012 — Optimized commands: prompt rewrite, not tool exposure

- Status: accepted
- Date: 2026-08-12

## Context

Many custom slash commands and skills are markdown prompts describing a
deterministic procedure — format, typecheck, commit, push. Every run
makes the agent re-derive those steps tool call by tool call, spending
thousands of tokens to reach the same end state each time. The
Optimization settings section lets a user distill such a command into a
script once, review it, and have subsequent runs cost one tool call.

Three designs were considered for how the approved script reaches the
agent:

1. A Mota-owned MCP stdio server exposing each approved command as a
   typed tool, driven by a manifest of script files.
2. Rewriting the outgoing prompt at send time: when the leading command
   has an approved script, the agent receives "run this exact script in
   one shell tool call" instead of the command text.
3. Running the script ourselves, bypassing the agent entirely.

## Decision

**Prompt rewrite (2), applied in `SendPrompt.execute`.** The chat
message, transcript and per-turn stats keep the text the user typed;
only the request's `prompt` field is rewritten (`optimizedPrompt` in
`src/core/entities/commandOptimization.ts`). The agent's own shell tool
executes the script under its normal permission policy.

Why not an MCP server (1), for now:

- It is a new long-lived process type, per provider, with lifecycle and
  failure modes of its own — against the grain of "lightweight is the
  product".
- MCP servers are fixed at `session/new`; changing the list respawns
  the session (see `ScopeMcpServer`). Approving a command would either
  force a respawn or wait for the next session.
- Tool schemas sit in the context of every request for the whole
  session, whether or not the command is used. For a token-saving
  feature, a per-use cost beats a per-turn one.
- The rewrite is provider-agnostic by construction; an MCP server needs
  per-provider enablement plumbing.

Why not running the script ourselves (3): argument judgment (a commit
message, a `{{placeholder}}`) and error recovery belong to the agent,
and its permission system is the user's protection when the script runs.

Supporting decisions:

- **The analysis run is one-shot headless** (`src-tauri/src/optimize.rs`),
  reusing the provider CLI fallback machinery under Manual permission —
  headless Manual cannot execute tools, so the analysis model can only
  read the inlined markdown and answer with a JSON verdict.
- **Scripts are portable POSIX sh with `{{placeholder}}` holes** the
  agent fills at run time, so one judgment value does not disqualify an
  otherwise deterministic command.
- **Partially deterministic commands become hybrids**: the verdict may
  carry `instructions` — the judgment steps rewritten as concise prompt
  text that orchestrates around the script. The rewrite sends both; the
  agent follows the short instructions and still runs the mechanical
  part as one call, so the saving holds even when a script alone can't.
- **Scripts live in settings (`AppSettings.commandOptimizations`), not
  on disk.** They are a few hundred bytes; workspace.json persistence is
  free, there is no file store to secure, and a hostile repo edit can
  only flip the "source changed" badge (the stored `sourceHash` no
  longer matches), never the approved script itself.
- **Analysis is grounded in run telemetry.** The command's recorded
  turns (run count, average tokens/duration, tool calls per run by
  kind, from `TurnStat`) are summarized (`commandRunEvidence`) and
  folded into both analysis prompts — what a command actually DID
  beats what its text implies. Best-effort: unreadable history never
  blocks an optimization.
- **Savings are derived, never persisted**, matching the Insights
  pattern: a command's turns split at `activatedAt` — before is the
  baseline, after are optimized runs — over the same billed-first,
  delta-fallback accounting as every other token ranking
  (`commandSavings` in `src/core/entities/insights.ts`).

- **A declined command can be optimized as a copy.** A second analysis
  pass applies the stored blockers' advice and returns a rewritten
  variant; after review it is written NEXT TO the source as
  `<name>-optimized.md` (`save_command_copy`, create-new only — never
  overwriting, never editing the user's original) and activated as an
  optimized command from birth.

## Consequences

- A user reviews and explicitly activates every script before it can
  run; a declined or discarded proposal persists nothing executable.
- "One tool call" is prompt-enforced, not guaranteed; the savings
  metric measures reality either way, including negative savings.
- Skills are analyzed from `SKILL.md` alone; ones that reference
  sibling files are declined by instruction, which is correct for v1.
- Revisit the MCP-server design when users need agent-initiated
  mid-task invocation or typed argument schemas — that ADR should also
  cover manifest integrity (script hashing) and respawn-as-update.
