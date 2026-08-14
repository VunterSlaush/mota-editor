import type { GitActionResult, GitVerb } from "../entities/gitAction";
import type { GitPort } from "../ports/gitPort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

// The shapes live in the entities layer, where the tab's state can also
// see them; re-exported here because this use case is what produces them.
export type { GitActionResult, GitVerb };

/**
 * Use case — the git verbs the Changes panel offers: stage/unstage a
 * file, push, pull. Errors come back as messages, never exceptions —
 * the panel shows them inline.
 *
 * Every verb that changes the repository publishes itself to the tab
 * while it runs, so the panel can be closed, reopened, or switched away
 * from without losing what git is doing.
 */
export class GitActions {
  constructor(
    private readonly store: Store,
    private readonly git: GitPort,
  ) {}

  async stage(tabId: string, path: string): Promise<GitActionResult> {
    return this.run(tabId, "file", (projectPath) =>
      this.git.stage(projectPath, path).then(() => ""),
    );
  }

  async unstage(tabId: string, path: string): Promise<GitActionResult> {
    return this.run(tabId, "file", (projectPath) =>
      this.git.unstage(projectPath, path).then(() => ""),
    );
  }

  /** Stage every change at once — one git call, not one per file. */
  async stageAll(tabId: string): Promise<GitActionResult> {
    return this.run(tabId, "file", (projectPath) =>
      this.git.stageAll(projectPath).then(() => ""),
    );
  }

  async unstageAll(tabId: string): Promise<GitActionResult> {
    return this.run(tabId, "file", (projectPath) =>
      this.git.unstageAll(projectPath).then(() => ""),
    );
  }

  /** Commit staged changes, then push — one gesture, stops on failure. */
  async commitAndPush(tabId: string, message: string): Promise<GitActionResult> {
    return this.run(tabId, "commit", async (projectPath) => {
      await this.git.commit(projectPath, message);
      return this.git.push(projectPath);
    });
  }

  /** The unified diff for one changed file, for the diff viewer. Asking
   *  a question, so it leaves the panel's own state alone. */
  async diff(
    tabId: string,
    path: string,
    staged: boolean,
    untracked: boolean,
  ): Promise<GitActionResult> {
    return this.attempt(tabId, (projectPath) =>
      this.git.diff(projectPath, path, staged, untracked),
    );
  }

  /** Reported by the branch picker, which stays open over its own
   *  outcome — the panel behind it has nothing to say meanwhile. */
  async checkout(tabId: string, branch: string): Promise<GitActionResult> {
    return this.attempt(tabId, (projectPath) => this.git.checkout(projectPath, branch));
  }

  async push(tabId: string): Promise<GitActionResult> {
    return this.run(tabId, "push", (projectPath) => this.git.push(projectPath));
  }

  async pull(tabId: string): Promise<GitActionResult> {
    return this.run(tabId, "pull", (projectPath) => this.git.pull(projectPath));
  }

  /** Safe to run mid-turn: it moves no files, only remote-tracking refs. */
  async fetch(tabId: string): Promise<GitActionResult> {
    return this.run(tabId, "fetch", (projectPath) => this.git.fetch(projectPath));
  }

  private async run(
    tabId: string,
    verb: GitVerb,
    action: (projectPath: string) => Promise<string>,
  ): Promise<GitActionResult> {
    this.store.dispatch({ type: "git/started", tabId, verb });
    const result = await this.attempt(tabId, action);
    this.store.dispatch({ type: "git/finished", tabId, result });
    return result;
  }

  private async attempt(
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
