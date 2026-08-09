import type { WorkspaceStore } from "../ports/workspacePort";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";

/**
 * Use case — move a project tab to another position in the bar. The saved
 * workspace stores tabs in list order, so persisting is all it takes for
 * the new arrangement to survive a restart.
 */
export class ReorderTabs {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(tabId: string, toIndex: number): Promise<void> {
    this.store.dispatch({ type: "tab/moved", tabId, toIndex });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}
