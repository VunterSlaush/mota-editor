import type { GitPort } from "../ports/gitPort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/** Outcome of a git verb, ready for display. */
export interface GitActionResult {
  readonly ok: boolean;
  readonly message: string;
}

/**
 * Use case — the git verbs the Changes panel offers: stage/unstage a
 * file, push, pull. Errors come back as messages, never exceptions —
 * the panel shows them inline.
 */
export class GitActions {
  constructor(
    private readonly store: Store,
    private readonly git: GitPort,
  ) {}

  async stage(tabId: string, path: string): Promise<GitActionResult> {
    return this.run(tabId, (projectPath) =>
      this.git.stage(projectPath, path).then(() => ""),
    );
  }

  async unstage(tabId: string, path: string): Promise<GitActionResult> {
    return this.run(tabId, (projectPath) =>
      this.git.unstage(projectPath, path).then(() => ""),
    );
  }

  /** Commit staged changes, then push — one gesture, stops on failure. */
  async commitAndPush(tabId: string, message: string): Promise<GitActionResult> {
    return this.run(tabId, async (projectPath) => {
      await this.git.commit(projectPath, message);
      return this.git.push(projectPath);
    });
  }

  /** The unified diff for one changed file, for the diff viewer. */
  async diff(
    tabId: string,
    path: string,
    staged: boolean,
    untracked: boolean,
  ): Promise<GitActionResult> {
    return this.run(tabId, (projectPath) =>
      this.git.diff(projectPath, path, staged, untracked),
    );
  }

  async checkout(tabId: string, branch: string): Promise<GitActionResult> {
    return this.run(tabId, (projectPath) => this.git.checkout(projectPath, branch));
  }

  async push(tabId: string): Promise<GitActionResult> {
    return this.run(tabId, (projectPath) => this.git.push(projectPath));
  }

  async pull(tabId: string): Promise<GitActionResult> {
    return this.run(tabId, (projectPath) => this.git.pull(projectPath));
  }

  /** Safe to run mid-turn: it moves no files, only remote-tracking refs. */
  async fetch(tabId: string): Promise<GitActionResult> {
    return this.run(tabId, (projectPath) => this.git.fetch(projectPath));
  }

  private async run(
    tabId: string,
    action: (projectPath: string) => Promise<string>,
  ): Promise<GitActionResult> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return { ok: false, message: "Unknown tab." };
    try {
      return { ok: true, message: await action(tab.project.path) };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}
