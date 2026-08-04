import {
  DemoAgentGateway,
  DemoCommandCatalog,
  DemoFilePicker,
  DemoFolderPicker,
  DemoGit,
  DemoNotifications,
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
import { TauriTranscriptStore } from "../adapters/tauri/tauriTranscriptStore";
import { TauriWorkspaceStore } from "../adapters/tauri/tauriWorkspaceStore";
import type { FilePicker } from "../core/ports/workspacePort";
import { Store } from "../core/state/store";
import { CancelTurn } from "../core/usecases/cancelTurn";
import { CloseProject } from "../core/usecases/closeProject";
import { GitActions } from "../core/usecases/gitActions";
import { SessionHistory } from "../core/usecases/history";
import { ListCommands } from "../core/usecases/listCommands";
import { LoadGitChanges } from "../core/usecases/loadGitChanges";
import { OpenProject } from "../core/usecases/openProject";
import { RespondPermission } from "../core/usecases/respondPermission";
import { RestoreWorkspace } from "../core/usecases/restoreWorkspace";
import { SendPrompt } from "../core/usecases/sendPrompt";
import {
  SelectEffort,
  SelectMode,
  SelectModel,
  SelectPermission,
  SelectProvider,
  SelectVerbose,
  SetDefaultProvider,
  SwitchTab,
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
  readonly setDefaultProvider: SetDefaultProvider;
  readonly sendPrompt: SendPrompt;
  readonly cancelTurn: CancelTurn;
  readonly respondPermission: RespondPermission;
  readonly listCommands: ListCommands;
  readonly filePicker: FilePicker;
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
    selectMode: new SelectMode(store, workspaceStore),
    selectPermission: new SelectPermission(store, workspaceStore),
    selectModel: new SelectModel(store, workspaceStore, agentGateway),
    selectEffort: new SelectEffort(store, workspaceStore, agentGateway),
    selectVerbose: new SelectVerbose(store, workspaceStore),
    loadGitChanges: new LoadGitChanges(store, gitPort),
    gitActions: new GitActions(store, gitPort),
    sendPrompt: new SendPrompt(
      store,
      agentGateway,
      workspaceStore,
      transcriptStore,
      notifications,
      newId,
    ),
    cancelTurn: new CancelTurn(store, agentGateway),
    respondPermission: new RespondPermission(store, agentGateway),
    listCommands: new ListCommands(store, commandCatalog),
    sessionHistory: new SessionHistory(store, transcriptStore, agentGateway),
    setDefaultProvider: new SetDefaultProvider(store, workspaceStore),
    filePicker,
    runningInTauri: inTauri,
  };
}
