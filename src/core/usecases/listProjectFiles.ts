import type { GitPort } from "../ports/gitPort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * Use case — the files in a project tab's folder, for the composer's "@"
 * menu. Anything that goes wrong (unknown tab, no git, no repository)
 * yields an empty list: the menu simply has nothing to offer, which is
 * never worth interrupting someone mid-sentence for.
 */
export class ListProjectFiles {
  constructor(
    private readonly store: Store,
    private readonly git: GitPort,
  ) {}

  async execute(tabId: string): Promise<string[]> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return [];
    return this.git.listFiles(tab.project.path).catch(() => []);
  }
}
