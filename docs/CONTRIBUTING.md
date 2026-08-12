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

1. `src-tauri/agent-core/src/providers/<vendor>.rs` — implement
   `Provider` (command + line parser), with `#[cfg(test)]` tests built
   from real captured CLI output.
2. Register it in `provider.rs::provider_for`.
3. Add its descriptor to `src/core/entities/provider.ts` (`PROVIDERS`).
4. That's all. If you needed to touch anything else, stop — the boundary
   is broken; fix that first.

## Writing an extension (no contribution to this repo needed)

Custom slash commands, agent tools, and automation can ship as an
**extension** — a folder with a manifest and any script, installed by
dropping it into `~/.mota/extensions/`. See `docs/EXTENSIONS.md` and the
working example in `examples/standup/`. The design is ADR-0012.
