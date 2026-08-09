# ADR-0006 — Git worktrees as tabs

- Status: accepted
- Date: 2026-08-09

## Context

One tab is one folder is one agent session (ADR-0005). Working two
branches of the same repository in parallel therefore meant cloning the
repository again. Git worktrees already solve this — several checkouts
sharing one `.git` — and a worktree is, to this app, just another
folder. What was missing was a way to list, create, and open them, and a
visual cue telling a worktree tab apart from a plain folder tab.

## Decision

- Worktrees are driven through the **`git worktree` CLI** (`list
  --porcelain`, `add`), through the same `run_git` helper as every other
  git command. No git library is linked (reaffirms ADR-0002's
  shell-out-to-the-official-CLI stance; agent-core stays serde-only).
- A tab knows it is a worktree via **`Project.worktreeOf`** — the main
  checkout's path — persisted as an optional field, so old workspace
  files load unchanged. It is set when a worktree is opened from the
  picker and auto-detected (one `git worktree list` on open) when a
  worktree folder is picked by hand, so the tab icon is always truthful:
  folder icon for plain projects, fork icon for worktrees.
- New worktrees land in a sibling container:
  `<parent>/<repo>-worktrees/<branch-slug>`. The slug replaces anything
  outside `[A-Za-z0-9._-]`, so `feature/x` nests no folders. Known-path
  collisions get a numeric suffix; on-disk collisions are git's to
  refuse, and its error shows inline in the picker.
- Worktrees for remote-only branches assume **`origin`**
  (`--track -b <branch> origin/<branch>`), consistent with the app's
  origin-only `remoteUrl`. `worktree add` does not DWIM remote branches
  the way `checkout` does, so the mode is explicit.
- **Closing a tab never deletes a worktree.** Removal (`git worktree
  remove`) is deferred: it is destructive, needs a `--force`-on-dirty
  decision UX, and interacts with tabs whose agents are mid-turn.

## Consequences

- A worktree tab's agent is fs-confined to the worktree (ADR-0005's
  `confine_to_project`), so it cannot reach the main checkout — the
  isolation that makes parallel agents safe is free. Git itself is
  unaffected: it resolves the worktree's `.git` pointer file on its own.
- Per-worktree chat history falls out of the path-hashed transcript keys;
  nothing was added for it.
- Two checkouts of one repo share refs and index locks. Two agents
  committing at once can still collide on the shared `.git` — git's own
  locking reports it; the app does not serialize them.
- The `--porcelain` parser reads `bare`, `detached`, `locked`, and
  `prunable` from day one, so listing never breaks on exotic states;
  the picker filters bare entries and badges locked ones.
