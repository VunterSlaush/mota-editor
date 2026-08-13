import { duplicatedProject } from "../entities/project";
import type { AgentGateway } from "../ports/agentGateway";
import type { WorkspaceStore } from "../ports/workspacePort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import type { IdGenerator } from "./openProject";
import { persistWorkspace } from "./persistWorkspace";
import { warmTab } from "./warmSessions";

/**
 * Use case — open a second tab on the folder a tab is already on, set up
 * the way that tab is. Two conversations in one project is the point: a
 * long one worth keeping and a fresh one for the next question, without
 * either costing the other.
 *
 * The only door to two tabs on one path — opening a folder that is
 * already open still activates the tab it is open in.
 */
export class DuplicateTab {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
    private readonly agentGateway: AgentGateway,
    private readonly newId: IdGenerator,
  ) {}

  async execute(tabId: string): Promise<void> {
    const source = tabById(this.store.getState(), tabId);
    if (!source) return;

    const project = duplicatedProject(source.project, this.newId());
    this.store.dispatch({ type: "tab/duplicated", sourceTabId: tabId, project });
    warmTab(this.store, this.agentGateway, project.id);
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}
