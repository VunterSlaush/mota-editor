import type { ProvisionEntry } from "../entities/worktree";
import type { WorkspaceStore } from "../ports/workspacePort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";

/**
 * Use case — give THIS project its own heavy-folder list for new
 * worktrees (undefined follows the app-wide default).
 *
 * Which folders are heavy is a property of the repository —
 * `node_modules` means nothing to a Go project — so the default list is
 * only a default, and a project can replace it. An empty list is a real
 * answer: "prepare nothing here."
 *
 * Unlike ScopeMcpServer, nothing needs respawning: the list is only
 * read the next time a worktree is created from this project.
 */
export class ScopeWorktreeProvisioning {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(
    tabId: string,
    provisioning: readonly ProvisionEntry[] | undefined,
  ): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return;
    this.store.dispatch({ type: "tab/provisioningChanged", tabId, provisioning });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}
