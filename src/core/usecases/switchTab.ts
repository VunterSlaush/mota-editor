import type { AgentMode, PermissionPolicy } from "../entities/agentSettings";
import type { ProviderId } from "../entities/provider";
import type { AgentGateway } from "../ports/agentGateway";
import type { WorkspaceStore } from "../ports/workspacePort";
import type { AppSettings } from "../state/appState";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";
import { warmTab } from "./warmSessions";

/** Use case — activate another project tab. */
export class SwitchTab {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(tabId: string): Promise<void> {
    this.store.dispatch({ type: "tab/activated", tabId });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}

/** Use case — choose which AI provider drives a project's chat. */
export class SelectProvider {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(tabId: string, provider: ProviderId): Promise<void> {
    this.store.dispatch({ type: "tab/providerChanged", tabId, provider });
    warmTab(this.store, this.agentGateway, tabId); // pre-start the new agent
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}

/** Use case — choose the agent's mode for a tab (agent / plan / debug). */
export class SelectMode {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(tabId: string, mode: AgentMode): Promise<void> {
    this.store.dispatch({ type: "tab/modeChanged", tabId, mode });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}

/** Use case — choose the permission policy for a tab. */
export class SelectPermission {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(tabId: string, permission: PermissionPolicy): Promise<void> {
    this.store.dispatch({ type: "tab/permissionChanged", tabId, permission });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}

/**
 * Use case — change the app-wide defaults that seed new project tabs.
 * Takes a patch so one settings screen needs one use case, not one per
 * field.
 */
export class UpdateSettings {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(patch: Partial<AppSettings>): Promise<void> {
    this.store.dispatch({ type: "settings/changed", patch });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}

/** Use case — toggle verbose chat (tool activity, thoughts, status). */
export class SelectVerbose {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(tabId: string, verbose: boolean): Promise<void> {
    this.store.dispatch({ type: "tab/verboseChanged", tabId, verbose });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}

/**
 * Use case — choose the model for a tab's agent (empty = provider
 * default). Takes effect on the next turn; over ACP a model change
 * restarts that tab's agent session.
 */
export class SelectModel {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(tabId: string, model: string): Promise<void> {
    this.store.dispatch({ type: "tab/modelChanged", tabId, model });
    warmTab(this.store, this.agentGateway, tabId); // restart with the new model
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}

/**
 * Use case — choose the reasoning effort for a tab's agent (empty =
 * provider default). Env-based over ACP, so a change restarts the
 * tab's session in the background.
 */
export class SelectEffort {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(tabId: string, effort: string): Promise<void> {
    this.store.dispatch({ type: "tab/effortChanged", tabId, effort });
    warmTab(this.store, this.agentGateway, tabId); // restart with the new effort
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}
