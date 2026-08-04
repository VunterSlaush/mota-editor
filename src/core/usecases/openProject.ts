import { newProject } from "../entities/project";
import type { AgentGateway } from "../ports/agentGateway";
import type { FolderPicker, WorkspaceStore } from "../ports/workspacePort";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";
import { warmTab } from "./warmSessions";

export type IdGenerator = () => string;

/**
 * Use case — let the user pick a folder and open it as a new project
 * tab, warming its agent session immediately. Opening an already-open
 * folder activates its existing tab instead.
 */
export class OpenProject {
  constructor(
    private readonly store: Store,
    private readonly folderPicker: FolderPicker,
    private readonly workspaceStore: WorkspaceStore,
    private readonly agentGateway: AgentGateway,
    private readonly newId: IdGenerator,
  ) {}

  async execute(): Promise<void> {
    const path = await this.folderPicker.pickFolder();
    if (!path) return;

    this.store.dispatch({
      type: "tab/opened",
      project: newProject(
        this.newId(),
        path,
        this.store.getState().settings.defaultProvider,
      ),
    });
    const activeTabId = this.store.getState().activeTabId;
    if (activeTabId) warmTab(this.store, this.agentGateway, activeTabId);
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}
