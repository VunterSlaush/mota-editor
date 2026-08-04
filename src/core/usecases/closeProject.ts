import type { Store } from "../state/store";
import type { AgentGateway } from "../ports/agentGateway";
import type { WorkspaceStore } from "../ports/workspacePort";
import { persistWorkspace } from "./persistWorkspace";

/**
 * Use case — close a project tab, tearing down its agent session (which
 * also stops any turn still running).
 */
export class CloseProject {
  constructor(
    private readonly store: Store,
    private readonly agentGateway: AgentGateway,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(tabId: string): Promise<void> {
    await this.agentGateway.cancelTurn(tabId).catch(() => undefined);
    await this.agentGateway.endSession(tabId).catch(() => undefined);
    this.store.dispatch({ type: "tab/closed", tabId });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}
