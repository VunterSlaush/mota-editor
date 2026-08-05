import {
  DemoAgentGateway,
  DemoCommandCatalog,
  DemoFilePicker,
  DemoFolderPicker,
  DemoGit,
  DemoNotifications,
  DemoProviderProbe,
  DemoTranscriptStore,
  DemoWorkspaceStore,
} from "../adapters/demo/demoAdapters";
import { isTauriRuntime } from "../adapters/tauri/runtime";
import { TauriAgentGateway } from "../adapters/tauri/tauriAgentGateway";
import { TauriCommandCatalog } from "../adapters/tauri/tauriCommandCatalog";
import { TauriFilePicker } from "../adapters/tauri/tauriFilePicker";
import { TauriFolderPicker } from "../adapters/tauri/tauriFolderPicker";
import { TauriGitStatus } from "../adapters/tauri/tauriGitStatus";
import { TauriNotifications } from "../adapters/tauri/tauriNotifications";
import { TauriProviderProbe } from "../adapters/tauri/tauriProviderProbe";
import { TauriTranscriptStore } from "../adapters/tauri/tauriTranscriptStore";
import { TauriWorkspaceStore } from "../adapters/tauri/tauriWorkspaceStore";
import type { ProviderProbe } from "../core/ports/providerProbe";
import type { FilePicker } from "../core/ports/workspacePort";
import { Store } from "../core/state/store";
import { ApplyCommandConfig } from "../core/usecases/applyCommandConfig";
import { CancelTurn } from "../core/usecases/cancelTurn";
import { CloseProject } from "../core/usecases/closeProject";
import { EditDraft } from "../core/usecases/editDraft";
import { GitActions } from "../core/usecases/gitActions";
import { SessionHistory } from "../core/usecases/history";
import { ListCommands } from "../core/usecases/listCommands";
import { LoadGitChanges } from "../core/usecases/loadGitChanges";
import { OpenProject } from "../core/usecases/openProject";
import { RespondPermission, RespondQuestion } from "../core/usecases/respondPermission";
import { RestoreWorkspace } from "../core/usecases/restoreWorkspace";
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
  readonly selectProvider: SelectProvider;
  readonly selectMode: SelectMode;
  readonly selectPermission: SelectPermission;
  readonly selectModel: SelectModel;
  readonly selectEffort: SelectEffort;
  readonly selectVerbose: SelectVerbose;
  readonly loadGitChanges: LoadGitChanges;
  readonly gitActions: GitActions;
  readonly sessionHistory: SessionHistory;
  readonly updateSettings: UpdateSettings;
  readonly sendPrompt: SendPrompt;
  readonly editDraft: EditDraft;
  readonly cancelTurn: CancelTurn;
  readonly respondPermission: RespondPermission;
  readonly respondQuestion: RespondQuestion;
  readonly listCommands: ListCommands;
  readonly providerProbe: ProviderProbe;
  readonly filePicker: FilePicker;
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
  const notifications = inTauri ? new TauriNotifications() : new DemoNotifications();
  const newId = () => crypto.randomUUID();

  // Session-level events (warm-up stages, agent mode switches) arrive
  // outside turns; registering the listener is the whole job.
  new SessionStatus(store, agentGateway);

  // Shared: the settings a slash command applies are the same use cases
  // the toolbar drives, so both routes persist and restart identically.
  const selectMode = new SelectMode(store, workspaceStore);
  const selectPermission = new SelectPermission(store, workspaceStore);
  const selectEffort = new SelectEffort(store, workspaceStore, agentGateway);

  return {
    store,
    restoreWorkspace: new RestoreWorkspace(store, workspaceStore, agentGateway),
    openProject: new OpenProject(
      store,
      folderPicker,
      workspaceStore,
      agentGateway,
      newId,
    ),
    closeProject: new CloseProject(store, agentGateway, workspaceStore),
    switchTab: new SwitchTab(store, workspaceStore),
    selectProvider: new SelectProvider(store, workspaceStore, agentGateway),
    selectMode,
    selectPermission,
    selectModel: new SelectModel(store, workspaceStore, agentGateway),
    selectEffort,
    selectVerbose: new SelectVerbose(store, workspaceStore),
    loadGitChanges: new LoadGitChanges(store, gitPort),
    gitActions: new GitActions(store, gitPort),
    sendPrompt: new SendPrompt(
      store,
      agentGateway,
      workspaceStore,
      transcriptStore,
      notifications,
      new ApplyCommandConfig(store, selectMode, selectPermission, selectEffort),
      newId,
    ),
    editDraft: new EditDraft(store),
    cancelTurn: new CancelTurn(store, agentGateway),
    respondPermission: new RespondPermission(store, agentGateway),
    respondQuestion: new RespondQuestion(store, agentGateway),
    listCommands: new ListCommands(store, commandCatalog),
    sessionHistory: new SessionHistory(store, transcriptStore, agentGateway),
    updateSettings: new UpdateSettings(store, workspaceStore),
    providerProbe: inTauri ? new TauriProviderProbe() : new DemoProviderProbe(),
    filePicker,
    newId,
    runningInTauri: inTauri,
  };
}
