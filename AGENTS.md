# Mota Editor — repository guidance

A Tauri 2 desktop app: React 18 + Vite frontend (`src/`), Rust backend
(`src-tauri/`). Clean Architecture on both sides of the process boundary.

Being lightweight and fast is the product, not a preference. Prefer the smallest
change that works, and treat every new dependency as a decision that needs a
reason.

## Commands

This repo uses **npm**. Never pnpm or yarn.

```
npm run dev            # Vite alone — demo adapters, no Rust backend
npm run tauri dev      # the real app, hot reload
npm run typecheck      # tsc --noEmit, strict
npm test               # vitest: core unit tests + the boundary rules
npm run lint           # biome check .
```

The pre-commit hook (`.githooks/pre-commit`) runs biome, `npm test`, and
`npm run typecheck`. It deliberately leaves out Rust — run that yourself before
pushing anything under `src-tauri/`:

```
cd src-tauri && cargo test -p agent-core && cargo clippy --workspace
```

## Working boundary

- Don't create or refresh a PR, push, or merge unless asked.
- Don't install, remove, or upgrade a dependency without explicit approval.
- Don't run `git reset --hard`, `git clean`, or a force-push unless the user
  named that outcome. Never pass `--no-verify`.
- A review, audit, or diagnosis request is read-only unless fixes were also
  requested.
- Preserve unrelated working-tree changes; stop if they block a safe scoped edit.
- A new dependency, boundary, or process gets an ADR in `docs/adr/`.

## Read on demand

Read the row matching the task before editing, and treat it as binding.

| Scope | Source |
|---|---|
| Layering, data flow, one turn end to end | `docs/ARCHITECTURE.md` |
| Naming, functions, tests, comments, boundaries | `docs/CODING_STANDARDS.md` |
| Adding an AI provider | `docs/CONTRIBUTING.md` § Adding an AI provider |
| Why a past decision was made | `docs/adr/` |

Those documents are the single source of truth — this file points at them and
never restates them. The boundary rules in `docs/CODING_STANDARDS.md` §
Boundaries are enforced by `npm test` (see `scripts/architecture.mjs`), so a
violation fails the build rather than waiting for review.
