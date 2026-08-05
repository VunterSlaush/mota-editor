import { useCallback, useState } from "react";
import type { ProviderId } from "../core/entities/provider";
import { activeTab } from "../core/state/appState";
import type { AppContext } from "../wiring/context";
import type { SidebarView } from "./components/ActivityBar";
import { ChatPanel } from "./components/ChatPanel";
import { EmptyState } from "./components/EmptyState";
import { SettingsModal } from "./components/SettingsModal";
import { TabBar } from "./components/TabBar";
import { openFileExternally } from "./openFile";
import { useAppState } from "./useAppState";

/**
 * UI — the application shell: tab bar on top, active project's chat below.
 * Humble view: renders state and forwards intents to use cases; no logic.
 */
export function App({ context }: { context: AppContext }) {
  const state = useAppState(context.store);
  const tab = activeTab(state);
  const [sidebarView, setSidebarView] = useState<SidebarView | null>("changes");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const projectPath = tab?.project.path ?? "";

  // Stable identity: the settings screen loads commands from an effect,
  // and a fresh closure every render would re-run it forever.
  const loadCommandsFor = useCallback(
    (provider: ProviderId) => context.listCommands.forProvider(projectPath, provider),
    [context, projectPath],
  );
  const probeProvider = useCallback(
    (provider: ProviderId) => context.providerProbe.probe(provider, projectPath),
    [context, projectPath],
  );
  // Stable identities: these reach memoized transcript rows (ApprovalCard)
  // and a document-level keydown effect; fresh arrows every render would
  // defeat the memo / re-register the listener on every streamed token.
  const activeProjectId = tab?.project.id ?? "";
  const respondPermission = useCallback(
    (requestId: string, optionId: string) =>
      void context.respondPermission.execute(activeProjectId, requestId, optionId),
    [context, activeProjectId],
  );
  const answerQuestion = useCallback(
    (requestId: string, answers: Record<string, string>) =>
      void context.respondQuestion.execute(activeProjectId, requestId, answers),
    [context, activeProjectId],
  );
  const retryLast = useCallback(
    () => void context.sendPrompt.retryLast(activeProjectId),
    [context, activeProjectId],
  );
  const readTerminal = useCallback(
    (terminalId: string) => context.readTerminalOutput(activeProjectId, terminalId),
    [context, activeProjectId],
  );
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  return (
    <div className="app">
      {!context.runningInTauri && (
        <div className="env-banner">
          Browser preview — you're driving a simulated demo agent. For real projects and
          agents, run <code>npm run tauri dev</code> and use the Mota Editor window it
          opens.
        </div>
      )}
      <TabBar
        tabs={state.tabs}
        activeTabId={state.activeTabId}
        onSelect={(tabId) => void context.switchTab.execute(tabId)}
        onClose={(tabId) => void context.closeProject.execute(tabId)}
        onOpenProject={() => void context.openProject.execute()}
      />
      {tab ? (
        <ChatPanel
          key={tab.project.id}
          tab={tab}
          sidebarView={sidebarView}
          onSelectSidebarView={setSidebarView}
          onOpenSettings={() => setSettingsOpen(true)}
          loadHistory={() => context.sessionHistory.list(tab.project.id)}
          onOpenSession={(sessionId, native) =>
            context.sessionHistory.open(tab.project.id, sessionId, native)
          }
          onDeleteSession={(sessionId) =>
            context.sessionHistory.remove(tab.project.id, sessionId)
          }
          onNewChat={() => context.sessionHistory.startNew(tab.project.id)}
          onSend={(prompt, attachments) =>
            void context.sendPrompt.execute(tab.project.id, prompt, attachments)
          }
          onDraftChange={(draft, attachments) =>
            context.editDraft.execute(tab.project.id, draft, attachments)
          }
          onRemoveQueued={(index) =>
            context.sendPrompt.removeQueued(tab.project.id, index)
          }
          onCancel={() => void context.cancelTurn.execute(tab.project.id)}
          onSelectProvider={(provider) =>
            void context.selectProvider.execute(tab.project.id, provider)
          }
          onSelectMode={(mode) => void context.selectMode.execute(tab.project.id, mode)}
          onSelectPermission={(permission) =>
            void context.selectPermission.execute(tab.project.id, permission)
          }
          onSelectModel={(model) =>
            void context.selectModel.execute(tab.project.id, model)
          }
          onSelectEffort={(effort) =>
            void context.selectEffort.execute(tab.project.id, effort)
          }
          onToggleVerbose={(verbose) =>
            void context.selectVerbose.execute(tab.project.id, verbose)
          }
          loadGitChanges={() => context.loadGitChanges.execute(tab.project.id)}
          onGitStage={(path) => context.gitActions.stage(tab.project.id, path)}
          onGitUnstage={(path) => context.gitActions.unstage(tab.project.id, path)}
          onGitCommitPush={(message) =>
            context.gitActions.commitAndPush(tab.project.id, message)
          }
          onGitCheckout={(branch) => context.gitActions.checkout(tab.project.id, branch)}
          onGitPush={() => context.gitActions.push(tab.project.id)}
          onGitPull={() => context.gitActions.pull(tab.project.id)}
          onGitFetch={() => context.gitActions.fetch(tab.project.id)}
          onGitDiff={(path, staged, untracked) =>
            context.gitActions.diff(tab.project.id, path, staged, untracked)
          }
          onOpenFile={(path) => openFileExternally(tab.project.path, path)}
          onRespondPermission={respondPermission}
          onAnswerQuestion={answerQuestion}
          onRetry={retryLast}
          onReadTerminal={readTerminal}
          loadCommands={() => context.listCommands.execute(tab.project.id)}
          onPickFiles={() => context.filePicker.pickFiles()}
        />
      ) : (
        <EmptyState onOpenProject={() => void context.openProject.execute()} />
      )}
      {settingsOpen && (
        <SettingsModal
          settings={state.settings}
          onChange={(patch) => void context.updateSettings.execute(patch)}
          loadCommands={loadCommandsFor}
          probeProvider={probeProvider}
          newId={context.newId}
          onClose={closeSettings}
        />
      )}
    </div>
  );
}
