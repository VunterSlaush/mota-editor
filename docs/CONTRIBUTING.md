# Contributing

Read [ARCHITECTURE.md](ARCHITECTURE.md) and
[CODING_STANDARDS.md](CODING_STANDARDS.md) first — reviews enforce both.

## Setup

Prerequisites: Node 20+, Rust (stable, via rustup), and the Tauri OS
prerequisites for your platform (see README → Development).

```
npm install
npm run tauri dev     # run the app with hot reload
```

## Before every commit

`npm install` points `core.hooksPath` at `.githooks/`, so the TypeScript
gates run themselves on commit: biome over the staged files, then

```
npm test              # vitest — frontend core + the boundary rules
npm run typecheck     # tsc --noEmit, strict
```

The hook skips both when no code moved, so a docs-only commit is instant.

Rust is **not** in the hook — `cargo clippy --workspace` is too slow to pay
for on every commit. Run it yourself before pushing anything under
`src-tauri/`:

```
cd src-tauri && cargo test -p agent-core && cargo clippy --workspace && cd ..
```

All four must be green with zero warnings. Fast tests only in these
suites — keep them in the seconds range (FIRST).

## Making changes

- Work test-first where practical (Three Laws of TDD); at minimum, no
  behavior lands without a test that fails when the behavior is removed.
- Respect the boundaries listed in CODING_STANDARDS.md § Boundaries. If a
  change forces an inner layer to import an outer name, the change is
  wrong, not the rule.
- Architectural decisions (new dependency, new boundary, new process) get
  an ADR in `docs/adr/`, numbered sequentially, before or with the PR.
- Commits: small, one intent each, imperative subject line
  ("Add Gemini resume support", not "added stuff").
- Boy Scout Rule applies: leave the files you touch a little cleaner.

## Adding an AI provider (the expected common contribution)

Two tiers, and it matters which one you are in.

**The boundary — two files.**

1. `src-tauri/agent-core/src/providers/<vendor>.rs` — implement
   `Provider` (command + line parser), with `#[cfg(test)]` tests built
   from real captured CLI output. Capture it; do not write a parser from
   the vendor's docs. A guessed schema does not fail loudly, it drops the
   agent's reply while reporting success. If you cannot capture the
   stream, parse only what you did capture and let the rest fall through
   to a plain-text reading of stdout (see `providers/cline.rs`).
2. Register it in `provider.rs::provider_for`.

If adding a provider forces a change to a **use case**, stop — that is
the boundary breaking, and it is the thing this list exists to catch.

**The tables that must name every provider.**

`ProviderId` is a closed union on purpose. Widen it and `tsc` lists every
table still missing a value; that list *is* the checklist, and today it
is `PROVIDERS`, `MODEL_SUGGESTIONS`, `EFFORT_OPTIONS`, `COMPACT_COMMAND`,
`BUILTIN_COMMANDS`, `BUILTIN_SUBAGENTS`, `DEFAULT_MODEL_MATCH` and
`COST_PRESETS` (which needs a model AND an effort per preset). Trust the
compiler over this sentence — it is the list that goes stale, not the
type. On the Rust side the equivalent is the `match provider_id` arms in
`acp.rs` (`agent_commands`, `agent_env`, `agent_args`, `sign_in_command`,
`native_mode_id`, `display_name`) plus `command_discovery.rs` and
`agent_discovery.rs`. Those two and `native_mode_id` fall through to
"nothing" rather than failing to compile, so an omission there is silent:
say in a comment that you meant it. `MODEL_PRICES` and
`MODEL_CONTEXT_WINDOWS` take rows only where you know the numbers —
absent means "n/a", which is the honest answer.

These are exhaustiveness devices, not boundary leaks: none of them
decides behaviour, they supply data an inner layer already asked for. The
compiler and `npm test` between them will not let you forget one.

ADR-0016 is a worked example, including what to do when an agent takes
its model on the command line instead of from the environment.

## Writing an extension (no contribution to this repo needed)

Custom slash commands, agent tools, and automation can ship as an
**extension** — a folder with a manifest and any script, installed by
dropping it into `~/.mota/extensions/`. See `docs/EXTENSIONS.md` and the
working example in `examples/standup/`. The design is ADR-0012.
