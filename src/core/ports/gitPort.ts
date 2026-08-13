/**
 * Ports layer — boundary for the project's version control. The core
 * cares about the answers (what changed, what's committed) and the
 * verbs (stage, unstage, push, pull) — never about how git is invoked.
 */
export interface GitChange {
  readonly path: string;
  readonly staged: boolean;
  readonly unstaged: boolean;
  readonly label: string;
}

export interface GitCommit {
  readonly hash: string;
  readonly subject: string;
  readonly author: string;
  readonly when: string;
}

export interface GitBranch {
  readonly name: string;
  readonly current: boolean;
  /** True for a branch that so far exists only on a remote; checking it
   *  out creates the local tracking branch. */
  readonly remote?: boolean;
}

/** How far the current branch has drifted from the branch it tracks:
 *  `behind` is what a pull would bring down, `ahead` what a push would
 *  send up. Both are counted against the last fetch, not the remote. */
export interface GitDivergence {
  readonly behind: number;
  readonly ahead: number;
}

/** One checkout of the repository. `branch` is "" on a detached HEAD. */
export interface GitWorktree {
  readonly path: string;
  readonly branch: string;
  readonly head: string;
  /** The main checkout — the one that owns the `.git` directory. */
  readonly main: boolean;
  readonly bare: boolean;
  readonly locked: boolean;
  readonly prunable: boolean;
}

/** How `worktreeAdd` gets its branch: check out an existing local one,
 *  create a new one from HEAD, or track a remote-only one from origin. */
export type WorktreeAddMode = "existing" | "new" | "remote";

/** Whether git may delete a worktree that still holds uncommitted work. */
export type WorktreeRemoveMode = "safe" | "force";

export interface GitPort {
  /** Changed files; throws when not a git repository. */
  changes(projectPath: string): Promise<GitChange[]>;
  /** Most recent commits, newest first. */
  log(projectPath: string, limit: number): Promise<GitCommit[]>;
  /** Local and remote-tracking branches, with the current one marked. */
  branches(projectPath: string): Promise<GitBranch[]>;
  /** The `origin` remote's URL, or "" when the repo has none. */
  remoteUrl(projectPath: string): Promise<string>;
  /**
   * Just the checked-out branch — one git call, for the tab strip, which
   * asks about every open project rather than only the active one. "" on
   * a detached HEAD, an empty repository, or a folder git knows nothing
   * about; all normal states.
   */
  currentBranch(projectPath: string): Promise<string>;
  /**
   * Commits waiting to be pulled and pushed, or null when there is
   * nothing to compare against — no upstream, a detached HEAD, or no
   * commits yet. All normal states, none of them an error.
   */
  upstream(projectPath: string): Promise<GitDivergence | null>;
  /**
   * Every file git knows about — tracked plus untracked-and-not-ignored
   * — as project-relative paths. Empty for a folder that is not a
   * repository: a normal state, not an error.
   */
  listFiles(projectPath: string): Promise<string[]>;
  /**
   * A unified diff for one file. `untracked` files have no index entry
   * to diff against and come back rendered wholly as additions.
   */
  diff(
    projectPath: string,
    path: string,
    staged: boolean,
    untracked: boolean,
  ): Promise<string>;
  stage(projectPath: string, path: string): Promise<void>;
  unstage(projectPath: string, path: string): Promise<void>;
  /** Commit staged changes. Resolves with a short summary. */
  commit(projectPath: string, message: string): Promise<string>;
  checkout(projectPath: string, branch: string): Promise<string>;
  /** Resolves with a short summary; throws with git's error message. */
  push(projectPath: string): Promise<string>;
  pull(projectPath: string): Promise<string>;
  /** Refresh remote-tracking refs without touching the working tree. */
  fetch(projectPath: string): Promise<string>;
  /** Every checkout of this repository, main first; throws when the
   *  folder is not a git repository. */
  worktrees(projectPath: string): Promise<GitWorktree[]>;
  /**
   * Create a worktree at an absolute path. Resolves with a summary.
   * `remote` is only consulted by the "remote" mode, `base` only by
   * "new" — each mode's start point, named where it means something.
   */
  worktreeAdd(
    projectPath: string,
    worktreePath: string,
    branch: string,
    mode: WorktreeAddMode,
    remote: string,
    /**
     * Where a "new" branch starts: a branch name, or "" for the asking
     * checkout's HEAD — git's own default, and the only thing this could
     * mean before the picker let anyone say otherwise.
     */
    base: string,
  ): Promise<string>;
  /**
   * Delete a linked worktree and its folder. "force" is what git needs
   * when the worktree still holds work; the backend refuses any path
   * that is not one of this repository's own linked checkouts.
   */
  worktreeRemove(
    projectPath: string,
    worktreePath: string,
    mode: WorktreeRemoveMode,
  ): Promise<string>;
  /** Forget worktrees whose folders are already gone. */
  worktreePrune(projectPath: string): Promise<string>;
  /** Branches already merged into `base`. */
  branchesMerged(projectPath: string, base: string): Promise<GitBranch[]>;
}
