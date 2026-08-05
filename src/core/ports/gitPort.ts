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
}

export interface GitPort {
  /** Changed files; throws when not a git repository. */
  changes(projectPath: string): Promise<GitChange[]>;
  /** Most recent commits, newest first. */
  log(projectPath: string, limit: number): Promise<GitCommit[]>;
  /** Local branches, with the current one marked. */
  branches(projectPath: string): Promise<GitBranch[]>;
  /** The `origin` remote's URL, or "" when the repo has none. */
  remoteUrl(projectPath: string): Promise<string>;
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
}
