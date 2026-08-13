import type { TabColorId } from "../entities/tabColor";
import type { WorkspaceStore } from "../ports/workspacePort";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";

/**
 * Use case — give a tab a name of its own. An empty name clears it, and
 * the tab goes back to being called after its folder.
 */
export class RenameTab {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(tabId: string, label: string): Promise<void> {
    this.store.dispatch({ type: "tab/labelChanged", tabId, label });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}

/**
 * Use case — mark a tab with a grouping colour, or `undefined` to take
 * the mark away.
 */
export class RecolorTab {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(tabId: string, color: TabColorId | undefined): Promise<void> {
    this.store.dispatch({ type: "tab/colorChanged", tabId, color });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}
