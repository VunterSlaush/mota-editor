---
name: merge-main
description: Merge the latest main into the current branch — fetch, fast-forward local main, merge, resolve conflicts, run the repo's checks. Never pushes.
---

# Merge main into the current branch

Bring the current feature branch up to date with `main`. This skill merges
and verifies; it never pushes, never rebases, and never touches `main`
beyond fast-forwarding it.

## Preconditions

- Working tree must be clean (`git status --short`). If it isn't, stop and
  tell the user what's dirty — don't stash or discard anything.
- If already on `main`, stop: there is nothing to merge into.

## Steps

1. **Fetch and fast-forward local main.**

   ```
   git fetch origin
   git fetch origin main:main
   ```

   The second command fast-forwards the local `main` branch without
   checking it out. If it fails (local `main` has diverged from origin),
   stop and ask the user which `main` they mean.

2. **Preview what's incoming.**

   ```
   git log --oneline HEAD..main
   git diff --stat HEAD...main
   ```

   If `HEAD..main` is empty, report the branch is already up to date and
   stop. Otherwise, briefly tell the user what's coming in.

3. **Merge.** `git merge main` — default merge commit, no flags. Never
   `--no-verify` (the pre-commit hook runs biome, `npm test`, and
   `npm run typecheck`).

4. **Resolve conflicts**, if any. Understand both sides before choosing:
   diff each conflicted file against the merge base for both branches
   (`git diff $(git merge-base HEAD main) <ref> -- <file>`) so the
   resolution keeps the *intent* of both changes, not just one side's text.

   Known pitfall: if git reports `Cannot merge binary files` for a source
   file, one side likely embeds a raw control byte (this happened with a
   raw NUL in a string literal in `src/ui/App.tsx`). Fix: extract base,
   ours, and theirs; replace the raw byte with its escape sequence
   (e.g. `"\u0000"` — same runtime value, valid text); then
   `git merge-file -p ours base theirs` and use the result.

5. **Verify** on the merged tree, before committing:

   ```
   npm run typecheck && npm test && npm run lint
   ```

   If the merge touched anything under `src-tauri/`:

   ```
   cd src-tauri && cargo test -p agent-core && cargo clippy --workspace
   ```

   Fix failures as part of the merge resolution (semantic conflicts —
   e.g. a rename on one side, a new call site on the other — surface
   here, not as textual conflicts).

6. **Commit.** Keep git's default merge message; if conflicts were
   resolved by hand, append a short note per file saying how.

7. **Report**: incoming commit count, files resolved by hand and how, and
   the check results. Do not push — that stays with the user.
