import type { ProjectFiles } from "../ports/projectFiles";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * Use case — the files in a project tab's folder, for the Files panel and
 * the composer's "@" menu. Anything that goes wrong (unknown tab, an
 * unreadable folder) yields an empty list: neither caller is worth
 * interrupting someone mid-sentence for.
 *
 * The disk is the listing, ignored files included. Git can answer this
 * question and used to, but `git ls-files --exclude-standard` hides exactly
 * the files people reach for a tree to find — `.env` above all — and a
 * listing that cannot show them is the wrong listing. The walk skips the
 * machine-generated folders nobody browses instead; see
 * `src-tauri/src/project_files.rs`.
 */
export class ListProjectFiles {
  constructor(
    private readonly store: Store,
    private readonly disk: ProjectFiles,
  ) {}

  async execute(tabId: string): Promise<string[]> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return [];
    return this.disk.walk(tab.project.path).catch(() => []);
  }
}
