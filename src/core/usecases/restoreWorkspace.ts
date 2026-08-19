import {
  clampAutoCompactThreshold,
  DEFAULT_MODE,
  DEFAULT_PERMISSION,
} from "../entities/agentSettings";
import { normalizedTabLabel, projectNameFromPath } from "../entities/project";
import { restoredBoundaryPresets, restoredSubtaskScope } from "../entities/subtask";
import { isTabColorId } from "../entities/tabColor";
import type { WorktreeSettings } from "../entities/worktree";
import { clampZoomLevel } from "../entities/zoom";
import type { AgentGateway } from "../ports/agentGateway";
import type { TranscriptStore } from "../ports/transcriptStore";
import type { PersistedSettings, WorkspaceStore } from "../ports/workspacePort";
import type { AppSettings, TabState } from "../state/appState";
import { defaultSettings, firstChatId } from "../state/appState";
import type { Store } from "../state/store";
import { restoreSessions } from "./restoreSessions";

/**
 * Use case — on startup, rebuild the tab set from the persisted
 * workspace and put each tab back into the conversation it was in.
 */
export class RestoreWorkspace {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
    private readonly agentGateway: AgentGateway,
    private readonly transcriptStore: TranscriptStore,
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
        // The file is untrusted input too: an empty or oversized string
        // must fall back to the folder name exactly as a never-set one does.
        label: normalizedTabLabel(p.label ?? ""),
        // The file may name a colour this build does not have.
        color: p.color && isTabColorId(p.color) ? p.color : undefined,
        verbose: p.verbose ?? true,
        providerSessions: p.providerSessions,
        mcpOverrides: p.mcpOverrides,
        provisioningOverride: p.provisioningOverride,
        worktreeOf: p.worktreeOf,
        subtask: restoredSubtaskScope(p.subtask),
        boundaryPresets: restoredBoundaryPresets(p.boundaryPresets),
      },
      chatId: firstChatId(p.id),
      messages: [],
      // A claim on the transcript this tab was writing to — honoured
      // only if the agent is still in that conversation. See TabState.
      restoredHistorySessionId: p.historySessionId,
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
    // Not awaited: the tab bar is already painted, and rejoining the
    // agents runs behind it.
    void restoreSessions(this.store, this.transcriptStore, this.agentGateway);
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
    autoCompactThreshold: clampAutoCompactThreshold(
      persisted?.autoCompactThreshold ?? defaultSettings.autoCompactThreshold,
    ),
    autoCompact: persisted?.autoCompact ?? defaultSettings.autoCompact,
    theme: persisted?.theme ?? defaultSettings.theme,
    zoomLevel: clampZoomLevel(persisted?.zoomLevel ?? defaultSettings.zoomLevel),
    worktrees: restoredWorktrees(persisted?.worktrees),
    terminalShell: persisted?.terminalShell ?? defaultSettings.terminalShell,
    terminalFontSize: persisted?.terminalFontSize ?? defaultSettings.terminalFontSize,
    terminalSuggestions:
      persisted?.terminalSuggestions ?? defaultSettings.terminalSuggestions,
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
