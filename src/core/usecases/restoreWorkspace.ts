import { DEFAULT_MODE, DEFAULT_PERMISSION } from "../entities/agentSettings";
import { projectNameFromPath } from "../entities/project";
import type { Store } from "../state/store";
import type { TabState } from "../state/appState";
import type { AgentGateway } from "../ports/agentGateway";
import type { WorkspaceStore } from "../ports/workspacePort";
import { warmAllTabs } from "./warmSessions";

/**
 * Use case — on startup, rebuild the tab set from the persisted
 * workspace and warm every tab's agent session in the background.
 */
export class RestoreWorkspace {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(): Promise<void> {
    const persisted = await this.workspaceStore.load();
    if (!persisted) return;

    const tabs: TabState[] = persisted.projects.map((p) => ({
      project: {
        id: p.id,
        path: p.path,
        name: projectNameFromPath(p.path),
        provider: p.provider,
        mode: p.mode ?? DEFAULT_MODE,
        permission: p.permission ?? DEFAULT_PERMISSION,
        model: p.model,
        effort: p.effort,
        verbose: p.verbose ?? true,
        providerSessions: p.providerSessions,
      },
      messages: [],
      busy: false,
      queued: [],
      agentCommands: [],
      plan: [],
    }));

    const activeTabId =
      tabs.find((t) => t.project.id === persisted.activeTabId)?.project.id ??
      tabs[0]?.project.id ??
      null;

    this.store.dispatch({
      type: "workspace/restored",
      tabs,
      activeTabId,
      settings: { defaultProvider: persisted.settings?.defaultProvider ?? "claude" },
    });
    warmAllTabs(this.store, this.agentGateway);
  }
}
