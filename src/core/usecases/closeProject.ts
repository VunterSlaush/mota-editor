import type { AgentGateway } from "../ports/agentGateway";
import type { ShellPort } from "../ports/shellPort";
import type { WorkspaceStore } from "../ports/workspacePort";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";

/**
 * Use case — close a project tab, tearing down its agent session (which
 * also stops any turn still running) and the terminals the user opened
 * in it.
 */
export class CloseProject {
  constructor(
    private readonly store: Store,
    private readonly agentGateway: AgentGateway,
    private readonly workspaceStore: WorkspaceStore,
    private readonly shells: ShellPort,
  ) {}

  async execute(tabId: string): Promise<void> {
    // Terminals first: on Windows a live shell holds a handle on its
    // working directory, and removing a worktree closes its tab before
    // trying to delete the folder.
    await this.shells.closeProject(tabId).catch(() => undefined);
    await this.agentGateway.cancelTurn(tabId).catch(() => undefined);
    await this.agentGateway.endSession(tabId).catch(() => undefined);
    this.store.dispatch({ type: "tab/closed", tabId });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}
