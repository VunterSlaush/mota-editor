import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { type AppBadge, appBadge, sameBadge } from "../core/entities/appBadge";
import type { ExtensionPanelRef } from "../core/entities/extension";
import { extensionPanels as panelsOfExtensions } from "../core/entities/extension";
import type { PanelView } from "../core/entities/extensionPanels";
import { tabLabel } from "../core/entities/project";
import type { ProviderId } from "../core/entities/provider";
import { isShellLine, shellCommand } from "../core/entities/shellLine";
import { tabShortcutIndex } from "../core/entities/tabShortcut";
import { themeById } from "../core/entities/theme";
import { applyZoomIntent, zoomFactor, zoomIntent } from "../core/entities/zoom";
import type { ShellSize } from "../core/ports/shellPort";
import type { TabState } from "../core/state/appState";
import { activeTab } from "../core/state/appState";
import type { GitChanges } from "../core/usecases/loadGitChanges";
import type { OpenShellRequest } from "../core/usecases/shells";
import type { AppContext } from "../wiring/context";
import type { SidebarView } from "./components/ActivityBar";
import type { RightPanel, ShellsView } from "./components/ChatPanel";
import { ChatPanel } from "./components/ChatPanel";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { EmptyState } from "./components/EmptyState";
import type { ExtensionPanelsView } from "./components/ExtensionPanel";
import { SettingsModal } from "./components/SettingsModal";
import { TabBar } from "./components/TabBar";
import { TooltipLayer } from "./components/TooltipLayer";
import { openFileExternally } from "./openFile";
import { useAppState } from "./useAppState";

/**
 * UI — the application shell: tab bar on top, active project's chat below.
 * Humble view: renders state and forwards intents to use cases; no logic.
 */
export function App({ context }: { context: AppContext }) {
  const state = useAppState(context.store);
  const tab = activeTab(state);
  // Which panels each project shows. Above ChatPanel, which is keyed by
  // project id and so remounts with empty state on every tab switch — a
  // terminal must still be showing when you come back to the project you
  // left it open on, and must NOT be showing on a project you never
  // opened one on.
  //
  // Not persisted: a panel is where you left it this session, and a
  // fresh start opens on Changes with nothing on the right.
  const [sidebarViews, setSidebarViews] = useState<
    Readonly<Record<string, SidebarView | null>>
  >({});
  const [rightPanels, setRightPanels] = useState<Readonly<Record<string, RightPanel>>>(
    {},
  );
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The tab a close is waiting on an answer about, and the tabs a quit
  // is. Null in both cases means nothing was asked.
  const [closingTabId, setClosingTabId] = useState<string | null>(null);
  const [quitBlockedBy, setQuitBlockedBy] = useState<readonly TabState[] | null>(null);
  const [supportsCow, setSupportsCow] = useState<boolean | null>(null);
  // Last-known git changes per project. ChatPanel remounts on every tab
  // switch (it is keyed by project id), so its own state starts empty;
  // seeding from here lets the sidebar paint the previous answer on the
  // first frame instead of blinking while git is asked again. A ref, not
  // state: a cache write must not re-render the app.
  const gitChangesCache = useRef(new Map<string, GitChanges>());
  // The same trick for extension panels, keyed by panel AND project (a
  // panel is handed the tab's context, so its answer may be per-project).
  // Without this, every tab switch asks the extension again — a visible
  // reload, and for a panel that talks to the network, a wasted call.
  const panelViewCache = useRef(new Map<string, PanelView>());
  const projectPath = tab?.project.path ?? "";
  // Undefined once the tab is gone, so a tab that closes another way
  // takes its own question with it.
  const closingTab = closingTabId
    ? state.tabs.find((t) => t.project.id === closingTabId)
    : undefined;

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

  // Extensions load once at startup and again when settings open (the
  // Reload button covers mid-session installs). The list drives the
  // command palette and MCP merge, so it must exist before settings do.
  useEffect(() => {
    void context.manageExtensions.load();
  }, [context]);
  useEffect(() => {
    if (settingsOpen) void context.manageExtensions.load();
  }, [context, settingsOpen]);

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

  // Every tab's branch, so the strip can say it before you have been in
  // that project — a restored workspace otherwise knows only the branch
  // of whichever tab you happen to click. Re-read when the set of tabs
  // changes (a project opened, a worktree added), not on every state
  // change: it is one git call per project, and one is enough.
  const tabIds = state.tabs.map((t) => t.project.id).join("\u0000");
  useEffect(() => {
    void context.loadBranches.execute();
  }, [context, tabIds]);

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

  // The window's close button, from now on, comes here first. Whether it
  // is allowed through is the use case's call — this only paints the
  // question when the answer is "ask".
  useEffect(() => {
    context.quitApp.guard(setQuitBlockedBy);
  }, [context]);

  // Ctrl+1…Ctrl+8 jump to a tab by position. Capture phase on the
  // window, and the event stops there: a focused terminal reads several
  // of these as control characters, and Ctrl+3 must switch tabs rather
  // than also sending ESC to the shell. The listener never re-registers
  // — which tab a digit means is the use case's to answer, read fresh
  // from the store on each press.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const index = tabShortcutIndex(e);
      if (index === null) return;
      e.preventDefault();
      e.stopPropagation();
      void context.switchTab.byIndex(index);
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () => window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [context]);

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
  // `null` is a real choice for the sidebar (closed), so the project
  // that has never been touched is the one whose id is ABSENT from the
  // map — not the one reading null.
  const sidebarView =
    activeProjectId in sidebarViews ? sidebarViews[activeProjectId] : "changes";
  const rightPanel = rightPanels[activeProjectId] ?? null;
  const selectSidebarView = useCallback(
    (view: SidebarView | null) => {
      if (!activeProjectId) return;
      setSidebarViews((all) => ({ ...all, [activeProjectId]: view }));
    },
    [activeProjectId],
  );
  const selectRightPanel = useCallback(
    (panel: RightPanel) => {
      if (!activeProjectId) return;
      setRightPanels((all) => ({ ...all, [activeProjectId]: panel }));
    },
    [activeProjectId],
  );
  // Stable for a third reason: both the Files panel and the composer's "@"
  // menu fetch this from an effect, and a fresh arrow every render would
  // have them re-listing the whole project on every keystroke.
  const loadProjectFiles = useCallback(
    () => context.listProjectFiles.execute(activeProjectId),
    [context, activeProjectId],
  );
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
  const requestCloseTab = useCallback(
    (tabId: string) => {
      if (context.closeProject.needsConfirmation(tabId)) setClosingTabId(tabId);
      else void context.closeProject.execute(tabId);
    },
    [context],
  );
  const cancelCloseTab = useCallback(() => setClosingTabId(null), []);
  const cancelQuit = useCallback(() => setQuitBlockedBy(null), []);

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
      suggestLine: (prefix: string) => context.shells.suggestFor(prefix),
    }),
    [context, activeProjectId, terminalFontSize, theme],
  );

  // Panels re-derive only when the extension list changes; the bundle
  // re-binds to whichever project is active, like every other intent.
  const panelRefs = useMemo(
    () => panelsOfExtensions(state.extensions),
    [state.extensions],
  );
  const extensionPanelsView: ExtensionPanelsView = useMemo(
    () => ({
      panels: panelRefs,
      cached: (panel) =>
        panelViewCache.current.get(panelCacheKey(panel, activeProjectId)) ?? null,
      remember: (panel, view) =>
        panelViewCache.current.set(panelCacheKey(panel, activeProjectId), view),
      load: (panel) => context.extensionPanels.load(panel, activeProjectId, projectPath),
      action: (panel, request) =>
        context.extensionPanels.action(panel, request, activeProjectId, projectPath),
      subscribe: (panel, onChanged) =>
        context.extensionPanels.onPanelChanged((extensionId, panelId) => {
          const mine =
            extensionId === panel.extensionId &&
            (panelId === undefined || panelId === panel.panelId);
          if (mine) onChanged();
        }),
    }),
    [context, panelRefs, activeProjectId, projectPath],
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
        onClose={requestCloseTab}
        onReorder={(tabId, toIndex) => void context.reorderTabs.execute(tabId, toIndex)}
        onOpenProject={() => void context.openProject.execute()}
        onRename={(tabId, label) => void context.renameTab.execute(tabId, label)}
        onRecolor={(tabId, color) => void context.recolorTab.execute(tabId, color)}
      />
      {tab ? (
        <ChatPanel
          key={tab.project.id}
          tab={tab}
          tabs={state.tabs}
          autoCompactThreshold={state.settings.autoCompactThreshold}
          defaultModel={state.settings.defaultModel[tab.project.provider] ?? ""}
          defaultEffort={state.settings.defaultEffort[tab.project.provider] ?? ""}
          cachedChanges={gitChangesCache.current.get(tab.project.id) ?? null}
          onChangesLoaded={(projectId, changes) => {
            if (changes) gitChangesCache.current.set(projectId, changes);
            else gitChangesCache.current.delete(projectId);
          }}
          sidebarView={sidebarView}
          onSelectSidebarView={selectSidebarView}
          extensionPanels={extensionPanelsView}
          rightPanel={rightPanel}
          onSelectRightPanel={selectRightPanel}
          shells={shells}
          onOpenSettings={() => setSettingsOpen(true)}
          loadHistory={(onRefresh) =>
            context.sessionHistory.list(tab.project.id, onRefresh)
          }
          loadWorktreeSessions={() =>
            context.sessionHistory.listWorktreeSessions(tab.project.id)
          }
          loadSessionKeywords={() => context.sessionHistory.keywords(tab.project.id)}
          onOpenSession={(item) => context.sessionHistory.open(tab.project.id, item)}
          onDeleteSession={(item) => context.sessionHistory.remove(tab.project.id, item)}
          onNewChat={() => context.sessionHistory.startNew(tab.project.id)}
          onSend={(prompt, attachments) => {
            // A "!" line was never meant for the agent: it runs in this
            // project's own terminal, which is also where its output
            // belongs — so show the panel on the way.
            if (isShellLine(prompt)) {
              selectRightPanel("terminal");
              context.shells.runLine(tab.project.id, shellCommand(prompt));
              return;
            }
            void context.sendPrompt.execute(tab.project.id, prompt, attachments);
          }}
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
          onGitStageAll={() => context.gitActions.stageAll(tab.project.id)}
          onGitUnstageAll={() => context.gitActions.unstageAll(tab.project.id)}
          onGitDiscard={(path) => context.gitActions.discard(tab.project.id, path)}
          onGitDiscardAll={() => context.gitActions.discardAll(tab.project.id)}
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
          onCreateWorktree={(branch, mode, base) =>
            context.worktrees.create(tab.project.id, branch, mode, base)
          }
          onRetryPreparing={() =>
            void context.worktrees.provision(
              tab.project.path,
              tab.project.worktreeOf ?? tab.project.path,
            )
          }
          onDismissWorktreeProblem={() =>
            context.worktrees.dismissProblem(tab.project.id)
          }
          onCheckWorktreeRemoval={(path) =>
            context.removeWorktree.check(tab.project.id, path)
          }
          onRemoveWorktree={(path, mode) =>
            context.removeWorktree.execute(tab.project.id, path, mode)
          }
          loadFolderCandidates={loadFolders}
          onNewSubtask={(scope) => context.subtasks.open(tab.project.id, scope)}
          onChangeSubtaskScope={(scope) =>
            context.subtasks.changeScope(tab.project.id, scope)
          }
          onActivateTab={(tabId) => void context.switchTab.execute(tabId)}
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
          loadProjectFiles={loadProjectFiles}
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
          extensions={state.extensions}
          onEnableExtension={(id) => void context.manageExtensions.enable(id)}
          onDisableExtension={(id) => void context.manageExtensions.disable(id)}
          onReloadExtensions={() => void context.manageExtensions.load()}
          readExtensionLog={(id) => context.manageExtensions.readLog(id)}
          supportsCow={supportsCow}
          loadFolders={projectPath ? loadFolders : undefined}
          onSaveBoundaryPresets={(presets) =>
            tab
              ? context.subtasks.savePresets(tab.project.id, presets)
              : Promise.resolve("No project open.")
          }
          onSuggestBoundaryPresets={() =>
            tab
              ? context.subtasks.suggestPresets(tab.project.id)
              : Promise.resolve({ presets: [], problem: "No project open." })
          }
          onClose={closeSettings}
        />
      )}
      {closingTab && (
        <ConfirmDialog
          title={`${tabLabel(closingTab.project)} is still working`}
          message="Closing this tab stops the turn the agent is running. It can't be resumed afterwards — the conversation stays in History, but the work in flight is lost."
          confirmLabel="Close anyway"
          onCancel={cancelCloseTab}
          onConfirm={() => {
            setClosingTabId(null);
            void context.closeProject.execute(closingTab.project.id);
          }}
        />
      )}
      {quitBlockedBy && quitBlockedBy.length > 0 && (
        <ConfirmDialog
          title={
            quitBlockedBy.length === 1
              ? "A tab is still working"
              : `${quitBlockedBy.length} tabs are still working`
          }
          message="Quitting stops every turn the agents are running. They can't be resumed afterwards — the conversations stay in History, but the work in flight is lost."
          detail={quitBlockedBy.map((t) => ({
            id: t.project.id,
            label: tabLabel(t.project),
          }))}
          confirmLabel="Quit anyway"
          onCancel={cancelQuit}
          onConfirm={() => {
            setQuitBlockedBy(null);
            void context.quitApp.execute();
          }}
        />
      )}
      {/* Last, so it draws over everything it can describe. */}
      <TooltipLayer />
    </div>
  );
}

function panelCacheKey(panel: ExtensionPanelRef, projectId: string): string {
  return `${panel.extensionId}:${panel.panelId}:${projectId}`;
}
