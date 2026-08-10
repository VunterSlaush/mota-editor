import {
  DemoAgentGateway,
  DemoBillingStore,
  DemoCommandCatalog,
  DemoFilePicker,
  DemoFolderPicker,
  DemoGit,
  DemoMcpProbe,
  DemoNotifications,
  DemoPastedImageStore,
  DemoProviderProbe,
  DemoTranscriptStore,
  DemoWorkspaceStore,
  DemoWorktreeProvisioning,
  DemoZoom,
} from "../adapters/demo/demoAdapters";
import { isTauriRuntime } from "../adapters/tauri/runtime";
import { TauriAgentGateway } from "../adapters/tauri/tauriAgentGateway";
import { TauriBillingStore } from "../adapters/tauri/tauriBillingStore";
import { TauriCommandCatalog } from "../adapters/tauri/tauriCommandCatalog";
import { TauriFilePicker } from "../adapters/tauri/tauriFilePicker";
import { TauriFolderPicker } from "../adapters/tauri/tauriFolderPicker";
import { TauriGitStatus } from "../adapters/tauri/tauriGitStatus";
import { TauriMcpProbe } from "../adapters/tauri/tauriMcpProbe";
import { TauriNotifications } from "../adapters/tauri/tauriNotifications";
import { TauriPastedImageStore } from "../adapters/tauri/tauriPastedImageStore";
import { TauriProviderProbe } from "../adapters/tauri/tauriProviderProbe";
import { TauriTranscriptStore } from "../adapters/tauri/tauriTranscriptStore";
import { TauriWorkspaceStore } from "../adapters/tauri/tauriWorkspaceStore";
import { TauriWorktreeProvisioning } from "../adapters/tauri/tauriWorktreeProvisioning";
import { TauriZoom } from "../adapters/tauri/tauriZoom";
import type { InsightsRange, InsightsReport } from "../core/entities/insights";
import type { McpProbe } from "../core/ports/mcpProbe";
import type { ProviderProbe } from "../core/ports/providerProbe";
import type { FilePicker, PastedImageStore } from "../core/ports/workspacePort";
import type { WorktreeProvisioning } from "../core/ports/worktreeProvisioning";
import type { ZoomPort } from "../core/ports/zoomPort";
import { Store } from "../core/state/store";
import { ApplyCommandConfig } from "../core/usecases/applyCommandConfig";
import { ApplyPendingSpec, DiscardPendingSpec } from "../core/usecases/applyPendingSpec";
import { CancelTurn } from "../core/usecases/cancelTurn";
import { CloseProject } from "../core/usecases/closeProject";
import { EditDraft } from "../core/usecases/editDraft";
import { GitActions } from "../core/usecases/gitActions";
import { SessionHistory } from "../core/usecases/history";
import { ListCommands } from "../core/usecases/listCommands";
import { ListProjectFiles } from "../core/usecases/listProjectFiles";
import { LoadGitChanges } from "../core/usecases/loadGitChanges";
import { LoadInsights } from "../core/usecases/loadInsights";
import { OpenProject } from "../core/usecases/openProject";
import { ReorderTabs } from "../core/usecases/reorderTabs";
import { RespondPermission, RespondQuestion } from "../core/usecases/respondPermission";
import { RestoreWorkspace } from "../core/usecases/restoreWorkspace";
import { ScopeMcpServer } from "../core/usecases/scopeMcpServer";
import { SendPrompt } from "../core/usecases/sendPrompt";
import { SessionStatus } from "../core/usecases/sessionStatus";
import {
  SelectEffort,
  SelectMode,
  SelectModel,
  SelectPermission,
  SelectProvider,
  SelectVerbose,
  SwitchTab,
  UpdateSettings,
} from "../core/usecases/switchTab";
import { RemoveWorktree, Worktrees } from "../core/usecases/worktrees";

/**
 * Composition root — the one place where concrete adapters are chosen and
 * wired into use cases (Uncle Bob's `Context` from the Clean Code case
 * study). Everything inward of here sees interfaces only.
 */
export interface AppContext {
  readonly store: Store;
  readonly restoreWorkspace: RestoreWorkspace;
  readonly openProject: OpenProject;
  readonly closeProject: CloseProject;
  readonly switchTab: SwitchTab;
  readonly reorderTabs: ReorderTabs;
  readonly selectProvider: SelectProvider;
  readonly selectMode: SelectMode;
  readonly selectPermission: SelectPermission;
  readonly selectModel: SelectModel;
  readonly selectEffort: SelectEffort;
  readonly applyPendingSpec: ApplyPendingSpec;
  readonly discardPendingSpec: DiscardPendingSpec;
  readonly selectVerbose: SelectVerbose;
  readonly scopeMcpServer: ScopeMcpServer;
  readonly loadGitChanges: LoadGitChanges;
  readonly gitActions: GitActions;
  readonly worktrees: Worktrees;
  /** Exposed for the settings panel, which asks what a copy would cost. */
  readonly worktreeProvisioning: WorktreeProvisioning;
  readonly removeWorktree: RemoveWorktree;
  readonly sessionHistory: SessionHistory;
  readonly updateSettings: UpdateSettings;
  readonly sendPrompt: SendPrompt;
  readonly editDraft: EditDraft;
  readonly cancelTurn: CancelTurn;
  readonly respondPermission: RespondPermission;
  readonly respondQuestion: RespondQuestion;
  readonly listCommands: ListCommands;
  readonly listProjectFiles: ListProjectFiles;
  /** Historical usage report for the settings Insights section. */
  readonly loadInsights: (range: InsightsRange) => Promise<InsightsReport>;
  readonly providerProbe: ProviderProbe;
  /** Measures what an MCP server's tools cost on every request. */
  readonly mcpProbe: McpProbe;
  readonly filePicker: FilePicker;
  readonly pastedImages: PastedImageStore;
  /** Live output of an agent-owned terminal, for the tool-call cards. */
  readonly readTerminalOutput: (
    tabId: string,
    terminalId: string,
  ) => Promise<{ output: string; truncated: boolean; exited: boolean } | null>;
  /** Scales the whole interface, driven by the Ctrl+= / Ctrl+- keys. */
  readonly zoom: ZoomPort;
  /** Ids for things the UI creates, e.g. a new MCP server row. */
  readonly newId: () => string;
  /** False when the UI is opened in a plain browser tab (no backend). */
  readonly runningInTauri: boolean;
}

export function createAppContext(): AppContext {
  const store = new Store();
  const inTauri = isTauriRuntime();
  const agentGateway = inTauri ? new TauriAgentGateway() : new DemoAgentGateway();
  const workspaceStore = inTauri ? new TauriWorkspaceStore() : new DemoWorkspaceStore();
  const folderPicker = inTauri ? new TauriFolderPicker() : new DemoFolderPicker();
  const filePicker = inTauri ? new TauriFilePicker() : new DemoFilePicker();
  const commandCatalog = inTauri ? new TauriCommandCatalog() : new DemoCommandCatalog();
  const gitPort = inTauri ? new TauriGitStatus() : new DemoGit();
  const transcriptStore = inTauri
    ? new TauriTranscriptStore()
    : new DemoTranscriptStore();
  const billingStore = inTauri ? new TauriBillingStore() : new DemoBillingStore();
  const mcpProbe = inTauri ? new TauriMcpProbe() : new DemoMcpProbe();
  const notifications = inTauri ? new TauriNotifications() : new DemoNotifications();
  const worktreeProvisioning = inTauri
    ? new TauriWorktreeProvisioning()
    : new DemoWorktreeProvisioning();
  const newId = () => crypto.randomUUID();

  // Session-level events (warm-up stages, agent mode switches) arrive
  // outside turns; registering the listener is the whole job.
  new SessionStatus(store, agentGateway);

  // Shared: the settings a slash command applies are the same use cases
  // the toolbar drives, so both routes persist and restart identically.
  // Removing a worktree closes its tab, and closing a tab is exactly
  // what CloseProject does — so it is shared rather than reimplemented.
  const closeProject = new CloseProject(store, agentGateway, workspaceStore);
  const selectMode = new SelectMode(store, workspaceStore);
  const selectPermission = new SelectPermission(store, workspaceStore);
  const selectEffort = new SelectEffort(store, workspaceStore, agentGateway);
  const selectModel = new SelectModel(store, workspaceStore, agentGateway);

  return {
    store,
    restoreWorkspace: new RestoreWorkspace(store, workspaceStore, agentGateway),
    openProject: new OpenProject(
      store,
      folderPicker,
      workspaceStore,
      agentGateway,
      newId,
      gitPort,
    ),
    closeProject,
    switchTab: new SwitchTab(store, workspaceStore),
    reorderTabs: new ReorderTabs(store, workspaceStore),
    selectProvider: new SelectProvider(store, workspaceStore, agentGateway),
    selectMode,
    selectPermission,
    selectModel,
    applyPendingSpec: new ApplyPendingSpec(store, workspaceStore, agentGateway),
    discardPendingSpec: new DiscardPendingSpec(store),
    selectEffort,
    selectVerbose: new SelectVerbose(store, workspaceStore),
    scopeMcpServer: new ScopeMcpServer(store, workspaceStore, agentGateway),
    loadGitChanges: new LoadGitChanges(store, gitPort),
    gitActions: new GitActions(store, gitPort),
    worktrees: new Worktrees(
      store,
      gitPort,
      workspaceStore,
      agentGateway,
      newId,
      worktreeProvisioning,
    ),
    worktreeProvisioning,
    removeWorktree: new RemoveWorktree(
      store,
      gitPort,
      worktreeProvisioning,
      closeProject,
    ),
    sendPrompt: new SendPrompt(
      store,
      agentGateway,
      workspaceStore,
      transcriptStore,
      notifications,
      new ApplyCommandConfig(
        store,
        selectMode,
        selectPermission,
        selectEffort,
        selectModel,
      ),
      newId,
    ),
    editDraft: new EditDraft(store),
    cancelTurn: new CancelTurn(store, agentGateway),
    respondPermission: new RespondPermission(store, agentGateway),
    respondQuestion: new RespondQuestion(store, agentGateway),
    listCommands: new ListCommands(store, commandCatalog),
    listProjectFiles: new ListProjectFiles(store, gitPort),
    loadInsights: (range) =>
      new LoadInsights(store, transcriptStore, billingStore).execute(range),
    sessionHistory: new SessionHistory(store, transcriptStore, agentGateway),
    updateSettings: new UpdateSettings(store, workspaceStore),
    providerProbe: inTauri ? new TauriProviderProbe() : new DemoProviderProbe(),
    mcpProbe,
    filePicker,
    pastedImages: inTauri ? new TauriPastedImageStore() : new DemoPastedImageStore(),
    readTerminalOutput: (tabId, terminalId) =>
      agentGateway.readTerminalOutput(tabId, terminalId),
    zoom: inTauri ? new TauriZoom() : new DemoZoom(),
    newId,
    runningInTauri: inTauri,
  };
}
