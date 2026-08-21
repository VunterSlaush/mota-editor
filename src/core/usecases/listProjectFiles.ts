import type { GitPort } from "../ports/gitPort";
import type { ProjectFiles } from "../ports/projectFiles";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * Use case — the files in a project tab's folder, for the Files panel and
 * the composer's "@" menu. Anything that goes wrong (unknown tab, no git,
 * an unreadable folder) yields an empty list: neither caller is worth
 * interrupting someone mid-sentence for.
 *
 * Git is asked first because it answers the question better than we could:
 * `git ls-files` already leaves out everything `.gitignore` names, so the
 * listing needs no ignore rules of its own. The disk is read only when git
 * has nothing — a folder that was never a repository — where the choice is
 * between reading it ourselves and showing the user none of their files.
 */
export class ListProjectFiles {
  constructor(
    private readonly store: Store,
    private readonly git: GitPort,
    private readonly disk: ProjectFiles,
  ) {}

  async execute(tabId: string): Promise<string[]> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return [];
    const tracked = await this.git.listFiles(tab.project.path).catch(() => []);
    if (tracked.length > 0) return tracked;
    return this.disk.walk(tab.project.path).catch(() => []);
  }
}
