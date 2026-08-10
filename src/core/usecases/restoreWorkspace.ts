import { DEFAULT_MODE, DEFAULT_PERMISSION } from "../entities/agentSettings";
import { projectNameFromPath } from "../entities/project";
import type { WorktreeSettings } from "../entities/worktree";
import { clampZoomLevel } from "../entities/zoom";
import type { AgentGateway } from "../ports/agentGateway";
import type { PersistedSettings, WorkspaceStore } from "../ports/workspacePort";
import type { AppSettings, TabState } from "../state/appState";
import { defaultSettings } from "../state/appState";
import type { Store } from "../state/store";
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
        mcpOverrides: p.mcpOverrides,
        worktreeOf: p.worktreeOf,
      },
      messages: [],
      busy: false,
      queued: [],
      agentCommands: [],
      plan: [],
      // Never restored: a pty cannot outlive the process that owned it.
      shells: [],
    }));

    const activeTabId =
      tabs.find((t) => t.project.id === persisted.activeTabId)?.project.id ??
      tabs[0]?.project.id ??
      null;

    this.store.dispatch({
      type: "workspace/restored",
      tabs,
      activeTabId,
      settings: restoredSettings(persisted.settings),
    });
    warmAllTabs(this.store, this.agentGateway);
  }
}

/** Field by field, so a file written before a setting existed still loads. */
function restoredSettings(persisted: PersistedSettings | undefined): AppSettings {
  return {
    defaultProvider: persisted?.defaultProvider ?? defaultSettings.defaultProvider,
    defaultMode: persisted?.defaultMode ?? defaultSettings.defaultMode,
    defaultPermission: persisted?.defaultPermission ?? defaultSettings.defaultPermission,
    defaultModel: persisted?.defaultModel ?? defaultSettings.defaultModel,
    defaultEffort: persisted?.defaultEffort ?? defaultSettings.defaultEffort,
    commandConfigs: persisted?.commandConfigs ?? defaultSettings.commandConfigs,
    mcpServers: persisted?.mcpServers ?? defaultSettings.mcpServers,
    autoCompactThreshold:
      persisted?.autoCompactThreshold ?? defaultSettings.autoCompactThreshold,
    autoCompact: persisted?.autoCompact ?? defaultSettings.autoCompact,
    theme: persisted?.theme ?? defaultSettings.theme,
    zoomLevel: clampZoomLevel(persisted?.zoomLevel ?? defaultSettings.zoomLevel),
    worktrees: restoredWorktrees(persisted?.worktrees),
    terminalShell: persisted?.terminalShell ?? defaultSettings.terminalShell,
    terminalFontSize: persisted?.terminalFontSize ?? defaultSettings.terminalFontSize,
  };
}

/** Field by field again, one level down, for the same reason. */
function restoredWorktrees(
  persisted: Partial<WorktreeSettings> | undefined,
): WorktreeSettings {
  const fallback = defaultSettings.worktrees;
  return {
    container: persisted?.container ?? fallback.container,
    remote: persisted?.remote ?? fallback.remote,
    provisioning: persisted?.provisioning ?? fallback.provisioning,
    inheritFromSourceTab:
      persisted?.inheritFromSourceTab ?? fallback.inheritFromSourceTab,
  };
}
