import type { GitPort } from "../ports/gitPort";
import type { Store } from "../state/store";

/**
 * Use case — which branch every open project is on.
 *
 * The Changes panel already learns this, but only for the tab you are
 * looking at, so a freshly restored workspace knows nothing about the
 * other tabs until you click through them — and the tab strip is exactly
 * where that answer is worth having, since with worktrees two tabs of
 * the same repository differ by nothing else.
 *
 * One git call per project, run together, deliberately kept away from
 * the panel's five: this asks about projects the user has not opened.
 */
export class LoadBranches {
  constructor(
    private readonly store: Store,
    private readonly git: GitPort,
  ) {}

  async execute(): Promise<void> {
    const tabs = this.store.getState().tabs;
    await Promise.all(tabs.map((tab) => this.load(tab.project.id, tab.project.path)));
  }

  /** A project git cannot answer for simply has no branch to show. */
  private async load(tabId: string, path: string): Promise<void> {
    const name = await this.git.currentBranch(path).catch(() => "");
    const branch = name === "" ? undefined : name;
    const tab = this.store.getState().tabs.find((t) => t.project.id === tabId);
    if (!tab || tab.branch === branch) return;
    this.store.dispatch({ type: "tab/branchUpdated", tabId, branch });
  }
}
