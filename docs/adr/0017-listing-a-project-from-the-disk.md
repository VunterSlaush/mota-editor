# ADR-0017 — Listing a project from the disk, ignored files included

- Status: accepted
- Date: 2026-08-25
- Supersedes: ADR-0016's listing decision (the tree, the panel and the "@"
  menu are otherwise unchanged)
- Relates to: ADR-0001 (lightweight is the product)

## Context

ADR-0016 made `git ls-files --cached --others --exclude-standard` the listing
behind the Files panel, with a disk walk as the fallback for a folder that was
never a repository. It closed by naming the cost:

> An ignored file — `.env`, something under `dist/` — is not in it, and in a
> repository there is no toggle to reveal it. That is the cost of not
> maintaining ignore rules, and it is the right one until someone needs the
> opposite.

Someone needs the opposite. `.env` is among the files edited most, and a file
tree that cannot show the file you edit most is not a file tree. Every project
here is a repository, so the fallback never ran and there was no way to ask
again.

## Decision

- **The disk is the listing.** `list_folder_files` answers for every project,
  repository or not. `ListProjectFiles` no longer chooses between two sources
  because there is only one, and the "@" menu gains ignored files from the same
  change — pointing an agent at `.env` was previously impossible.
- **The git listing is deleted, not left dormant.** `git_list_files`,
  `GitPort.listFiles`, its two adapters and `vcs::parse_ls_files` are gone. A
  second way to answer a question the app no longer asks is weight, and one
  `read_dir` walk is cheaper than spawning `git` on every refresh.
- **A fixed skip list replaces `.gitignore`.** `SKIPPED_FOLDERS` in
  `src-tauri/src/project_files.rs` grows the names `.gitignore` used to hide
  for us — `.next`, `.turbo`, `coverage`, `__pycache__` — alongside the
  `node_modules`/`target`/`dist` set it already had. It is a list this app now
  maintains, which ADR-0016 declined to do; the answer to that is that the list
  is short, the names are the same in every ecosystem, and the alternative is a
  Next.js project pushing its build output through the 20 000-file cap.
- **Union with git was considered and dropped.** Merging both listings would
  have kept committed files inside a skipped folder visible, at the cost of
  keeping both code paths, both round trips and the question of which one is
  authoritative. One source of truth is the lighter answer.

## Consequences

- Ignored files appear everywhere the project is listed: the tree, its search,
  and the composer's "@" menu. That is the point, and it means `.env.local`,
  stray logs and editor droppings appear too.
- A repository that *commits* files inside a skipped folder — a vendored
  `vendor/`, a published `dist/` — no longer shows them. The skip list is
  where to fix that if anyone hits it.
- Global git excludes and `.git/info/exclude` stop affecting the tree. Nobody
  was relying on them for this, and they were invisible where they did apply.
- The 20 000-file cap is now enforced during the walk rather than after git's
  output, and still truncates silently. Unchanged from ADR-0016, still worth
  knowing before someone debugs it.
- `MAX_PROJECT_FILES` moved from `agent-core::vcs` into `project_files.rs`: it
  stopped being a version-control concern when the git listing went away.
