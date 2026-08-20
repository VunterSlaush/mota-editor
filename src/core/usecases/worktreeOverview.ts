import type { TabStatus } from "../entities/tabStatus";
import { tabStatus } from "../entities/tabStatus";
import { samePath } from "../entities/worktree";
import type { GitWorktree } from "../ports/gitPort";
import type { TabState } from "../state/appState";

/**
 * Use case — what the worktree panel draws: one row per checkout of the
 * repository, told apart by what this workspace is doing with it.
 *
 * Pure on purpose. The listing itself costs one `git worktree list`
 * (`Worktrees.list`); everything a row says beyond that is read from the
 * open tabs, so a running agent's row stays live without asking git
 * anything at all.
 */
export interface WorktreeRow {
  readonly path: string;
  /** "" on a detached HEAD — the view names the head instead. */
  readonly branch: string;
  readonly head: string;
  /** The main checkout — the one that owns the `.git` directory. */
  readonly main: boolean;
  /** Git still lists it, but its folder is gone: nothing to open. */
  readonly prunable: boolean;
  /** The tab showing this worktree, or null when nobody has it open. */
  readonly openTabId: string | null;
  /** True for the checkout the panel is being shown from. */
  readonly current: boolean;
  /** The open tab's indicator; `idle` when the worktree is closed. */
  readonly status: TabStatus;
}

/**
 * The rows for `currentPath`'s repository. Bare entries are left out —
 * a bare checkout has no working tree, so there is no folder to open as
 * a tab (the picker drops them for the same reason). Git's own order is
 * kept, which puts the main checkout first.
 */
export function worktreeOverview(
  worktrees: readonly GitWorktree[],
  tabs: readonly TabState[],
  currentPath: string,
): WorktreeRow[] {
  return worktrees
    .filter((worktree) => !worktree.bare)
    .map((worktree) => {
      // `samePath`, not the reducer's exact-string dedup: git prints
      // `C:/repo` where the OS dialog hands back `C:\repo`.
      const open = tabs.find((tab) => samePath(tab.project.path, worktree.path));
      return {
        path: worktree.path,
        branch: worktree.branch,
        head: worktree.head,
        main: worktree.main,
        prunable: worktree.prunable,
        openTabId: open?.project.id ?? null,
        current: samePath(currentPath, worktree.path),
        // The tab bar's own verdict, so the two dots never disagree.
        status: open ? tabStatus(open) : "idle",
      };
    });
}

/**
 * The rows matching what the user typed into the panel's search box.
 *
 * Branch and path both, because a worktree is known by either — the
 * branch is what you were told to review, the folder is what you cloned
 * it into, and which one you remember is not something a search box gets
 * to decide. Every whitespace-separated word must match somewhere, so
 * "art edit" narrows rather than widens; case is ignored, and so is the
 * difference between the separators git and Windows disagree on.
 */
export function filterWorktreeRows(
  rows: readonly WorktreeRow[],
  query: string,
): WorktreeRow[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const haystack = `${row.branch} ${row.path} ${row.head}`
      .toLowerCase()
      .replace(/\\/g, "/");
    return words.every((word) => haystack.includes(word.replace(/\\/g, "/")));
  });
}
