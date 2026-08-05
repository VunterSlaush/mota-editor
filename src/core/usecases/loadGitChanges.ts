import type { GitBranch, GitChange, GitCommit, GitPort } from "../ports/gitPort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

const COMMIT_LOG_LIMIT = 15;

/** Everything the Changes panel shows. */
export interface GitChanges {
  readonly staged: readonly GitChange[];
  readonly unstaged: readonly GitChange[];
  readonly commits: readonly GitCommit[];
  readonly branches: readonly GitBranch[];
  /** The `origin` URL, "" when there is none — commits link off it. */
  readonly remote: string;
}

/**
 * Use case — the project's changed files (split staged / unstaged) and
 * its last commits. Returns null when the folder isn't a git repository
 * (a normal situation, not an error).
 */
export class LoadGitChanges {
  constructor(
    private readonly store: Store,
    private readonly git: GitPort,
  ) {}

  async execute(tabId: string): Promise<GitChanges | null> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return null;

    try {
      const path = tab.project.path;
      const [changes, commits, branches, remote] = await Promise.all([
        this.git.changes(path),
        this.git.log(path, COMMIT_LOG_LIMIT).catch(() => []),
        this.git.branches(path).catch(() => []),
        this.git.remoteUrl(path).catch(() => ""),
      ]);
      return {
        staged: changes.filter((c) => c.staged),
        unstaged: changes.filter((c) => c.unstaged),
        commits,
        branches,
        remote,
      };
    } catch {
      return null;
    }
  }
}
