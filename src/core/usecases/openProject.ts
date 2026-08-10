import { newProject } from "../entities/project";
import type { AgentGateway } from "../ports/agentGateway";
import type { GitPort } from "../ports/gitPort";
import type { FolderPicker, WorkspaceStore } from "../ports/workspacePort";
import { projectDefaults } from "../state/appState";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";
import { warmTab } from "./warmSessions";
import { detectWorktreeOf } from "./worktrees";

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
    private readonly git: GitPort,
  ) {}

  async execute(): Promise<void> {
    const path = await this.folderPicker.pickFolder();
    if (!path) return;

    // A picked folder may itself be a linked worktree — mark it so the
    // tab's icon tells the truth however the folder was opened.
    const worktreeOf = await detectWorktreeOf(this.git, path);
    this.store.dispatch({
      type: "tab/opened",
      project: newProject(
        this.newId(),
        path,
        projectDefaults(this.store.getState().settings),
        worktreeOf,
      ),
    });
    const activeTabId = this.store.getState().activeTabId;
    if (activeTabId) warmTab(this.store, this.agentGateway, activeTabId);
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}
