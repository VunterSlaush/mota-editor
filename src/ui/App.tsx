import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AppBadge, appBadge, sameBadge } from "../core/entities/appBadge";
import type { ProviderId } from "../core/entities/provider";
import { themeById } from "../core/entities/theme";
import { applyZoomIntent, zoomFactor, zoomIntent } from "../core/entities/zoom";
import type { ShellSize } from "../core/ports/shellPort";
import { activeTab } from "../core/state/appState";
import type { OpenShellRequest } from "../core/usecases/shells";
import type { AppContext } from "../wiring/context";
import type { SidebarView } from "./components/ActivityBar";
import type { RightPanel, ShellsView } from "./components/ChatPanel";
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
  // Above ChatPanel, which is keyed by project id: a terminal must still
  // be showing when you come back from another project.
  const [rightPanel, setRightPanel] = useState<RightPanel>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [supportsCow, setSupportsCow] = useState<boolean | null>(null);
  const projectPath = tab?.project.path ?? "";

  // Asked once per project, and only lazily: the probe writes a file to
  // find out, so it is not something to do on every settings render.
  useEffect(() => {
    if (!settingsOpen || !projectPath) return;
    let cancelled = false;
    context.worktreeProvisioning
      .supportsCow(projectPath)
      .then((can) => {
        if (!cancelled) setSupportsCow(can);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [context, settingsOpen, projectPath]);

  // The theme is a document-level attribute: the CSS palettes hang off
  // `[data-theme]`, so one line here restyles everything at once.
  useEffect(() => {
    document.documentElement.dataset.theme = themeById(state.settings.theme).id;
  }, [state.settings.theme]);

  // Zoom is the webview's own, not a CSS trick, so it survives every
  // fixed position and hairline border the layout leans on.
  const zoomLevel = state.settings.zoomLevel;
  useEffect(() => {
    void context.zoom.apply(zoomFactor(zoomLevel)).catch(() => undefined);
  }, [context, zoomLevel]);

  // The taskbar/dock badge — the tab dots, said once for the whole app
  // so a minimised window can still get your attention. Pushed only when
  // the badge actually changes: every keystroke of a streaming turn
  // dispatches, and none of them alter what the icon should say.
  const badge = useMemo(() => appBadge(state.tabs), [state.tabs]);
  const shownBadge = useRef<AppBadge | null>(null);
  useEffect(() => {
    if (sameBadge(shownBadge.current, badge)) return;
    shownBadge.current = badge;
    void context.appBadge.show(badge);
  }, [context, badge]);

  // Ctrl+= / Ctrl+- / Ctrl+0, wherever the caret is: zoom belongs to the
  // window, so a composer with focus must not swallow it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const intent = zoomIntent(e);
      if (!intent) return;
      e.preventDefault();
      const next = applyZoomIntent(zoomLevel, intent);
      if (next !== zoomLevel) void context.updateSettings.execute({ zoomLevel: next });
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [context, zoomLevel]);

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
  const signInProvider = useCallback(
    (provider: ProviderId) => context.providerProbe.signIn(provider),
    [context],
  );
  const loadFolders = useCallback(
    () => context.worktreeProvisioning.folderCandidates(projectPath),
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
  const activeProvider = tab?.project.provider;
  const signInActiveProvider = useCallback(
    () => void (activeProvider && context.providerProbe.signIn(activeProvider)),
    [context, activeProvider],
  );
  const readTerminal = useCallback(
    (terminalId: string) => context.readTerminalOutput(activeProjectId, terminalId),
    [context, activeProjectId],
  );
  const closeSettings = useCallback(() => setSettingsOpen(false), []);

  // Stable identity: these reach a component that creates and holds live
  // xterm instances in effects, and a fresh object every render would
  // tear the terminal down and rebuild it on every streamed token.
  const { terminalFontSize, theme } = state.settings;
  const shells: ShellsView = useMemo(
    () => ({
      fontSize: terminalFontSize,
      theme,
      open: (request: OpenShellRequest) => context.shells.open(activeProjectId, request),
      write: (sessionId: string, data: string) => context.shells.write(sessionId, data),
      acceptSuggestion: (sessionId: string) => context.shells.acceptSuggestion(sessionId),
      resize: (sessionId: string, size: ShellSize) =>
        context.shells.resize(sessionId, size),
      select: (sessionId: string) => context.shells.select(activeProjectId, sessionId),
      close: (sessionId: string) => void context.shells.close(activeProjectId, sessionId),
    }),
    [context, activeProjectId, terminalFontSize, theme],
  );

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
        onReorder={(tabId, toIndex) => void context.reorderTabs.execute(tabId, toIndex)}
        onOpenProject={() => void context.openProject.execute()}
      />
      {tab ? (
        <ChatPanel
          key={tab.project.id}
          tab={tab}
          autoCompactThreshold={state.settings.autoCompactThreshold}
          sidebarView={sidebarView}
          onSelectSidebarView={setSidebarView}
          rightPanel={rightPanel}
          onSelectRightPanel={setRightPanel}
          shells={shells}
          onOpenSettings={() => setSettingsOpen(true)}
          loadHistory={(onRefresh) =>
            context.sessionHistory.list(tab.project.id, onRefresh)
          }
          onOpenSession={(sessionId, native, savedAt) =>
            context.sessionHistory.open(tab.project.id, sessionId, native, savedAt)
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
          onApplyPendingSpec={() => void context.applyPendingSpec.execute(tab.project.id)}
          onDiscardPendingSpec={() => context.discardPendingSpec.execute(tab.project.id)}
          onCompactNow={() => void context.sendPrompt.compactNow(tab.project.id)}
          onDismissContextFull={() =>
            context.sendPrompt.dismissContextFull(tab.project.id)
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
          loadWorktrees={() => context.worktrees.list(tab.project.id)}
          onOpenWorktree={(path, mainPath) =>
            void context.worktrees.open(path, mainPath, tab.project.id)
          }
          onCreateWorktree={(branch, mode) =>
            context.worktrees.create(tab.project.id, branch, mode)
          }
          onRetryPreparing={() =>
            void context.worktrees.provision(
              tab.project.path,
              tab.project.worktreeOf ?? tab.project.path,
            )
          }
          onCheckWorktreeRemoval={(path) =>
            context.removeWorktree.check(tab.project.id, path)
          }
          onRemoveWorktree={(path, mode) =>
            context.removeWorktree.execute(tab.project.id, path, mode)
          }
          onOpenFile={(path) => openFileExternally(tab.project.path, path)}
          onRespondPermission={respondPermission}
          onAnswerQuestion={answerQuestion}
          onRetry={retryLast}
          onSignIn={signInActiveProvider}
          onReadTerminal={readTerminal}
          loadCommands={() => context.listCommands.execute(tab.project.id)}
          onPickFiles={() => context.filePicker.pickFiles()}
          onPasteImage={(bytes, mimeType) =>
            context.pastedImages.saveImage(bytes, mimeType)
          }
          loadProjectFiles={() => context.listProjectFiles.execute(tab.project.id)}
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
          signInProvider={signInProvider}
          loadInsights={context.loadInsights}
          tabs={state.tabs}
          activeTab={tab}
          mcpProbe={context.mcpProbe}
          onScopeMcpServer={(serverId, enabled) => {
            if (tab)
              void context.scopeMcpServer.execute(tab.project.id, serverId, enabled);
          }}
          onScopeProvisioning={(entries) => {
            if (tab)
              void context.scopeWorktreeProvisioning.execute(tab.project.id, entries);
          }}
          newId={context.newId}
          supportsCow={supportsCow}
          loadFolders={projectPath ? loadFolders : undefined}
          onClose={closeSettings}
        />
      )}
    </div>
  );
}
