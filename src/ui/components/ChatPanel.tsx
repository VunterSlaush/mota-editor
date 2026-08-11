import { GitBranch, GitFork, NotePencil, TerminalWindow } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentMode, PermissionPolicy } from "../../core/entities/agentSettings";
import { type CommandInfo, commandNames } from "../../core/entities/command";
import type { ProviderId } from "../../core/entities/provider";
import { providerById } from "../../core/entities/provider";
import { agentEditedFiles, countFileChangingTools } from "../../core/entities/tool";
import type { RemovalCheck } from "../../core/entities/worktree";
import type { WorktreeAddMode, WorktreeRemoveMode } from "../../core/ports/gitPort";
import type { ShellSize } from "../../core/ports/shellPort";
import type { TabState } from "../../core/state/appState";
import type { GitActionResult } from "../../core/usecases/gitActions";
import type { HistoryItem, HistoryListing } from "../../core/usecases/history";
import type { GitChanges } from "../../core/usecases/loadGitChanges";
import type { OpenShellRequest, OpenShellResult } from "../../core/usecases/shells";
import type { WorktreeItem } from "../../core/usecases/worktrees";
import { useDragWidth } from "../useDragWidth";
import { ActivityBar, type SidebarView } from "./ActivityBar";
import { BranchPicker } from "./BranchPicker";
import { ChangesPanel } from "./ChangesPanel";
import { Composer } from "./Composer";
import { ContextFullBar } from "./ContextFullBar";
import { DiffModal } from "./DiffModal";
import { HistoryPanel } from "./HistoryPanel";
import { MessageList } from "./MessageList";
import { PendingSpecBar } from "./PendingSpecBar";
import { PlanBar, PlanModal, PlanSidePanel } from "./PlanPanel";
import { ProviderPicker } from "./ProviderPicker";
import { TerminalPanel } from "./TerminalPanel";
import { WorktreePicker } from "./WorktreePicker";

/**
 * Which panel occupies the right-hand column. One at a time: two
 * resizable columns beside a chat leaves the chat with nothing.
 */
export type RightPanel = "plan" | "terminal" | null;

/**
 * What the terminal panel needs from outside, bundled — this component
 * already takes more props than it should, and a terminal is six more.
 */
export interface ShellsView {
  readonly fontSize: number;
  readonly theme: string;
  readonly open: (request: OpenShellRequest) => Promise<OpenShellResult>;
  readonly write: (sessionId: string, data: string) => void;
  readonly acceptSuggestion: (sessionId: string) => void;
  readonly resize: (sessionId: string, size: ShellSize) => void;
  readonly select: (sessionId: string) => void;
  readonly close: (sessionId: string) => void;
}

/** A burst of agent edits should cost one `git status`, not twenty. */
const GIT_RELOAD_DEBOUNCE_MS = 400;

/** Stable identity for the common "no attachments" case. */
const EMPTY_ATTACHMENTS: readonly string[] = [];

/** The file whose diff the modal is showing, and which side of it. */
type DiffTarget =
  | {
      readonly kind: "git";
      readonly path: string;
      readonly staged: boolean;
      readonly untracked: boolean;
    }
  | {
      readonly kind: "agent";
      readonly path: string;
      readonly oldText?: string;
      readonly newText: string;
    };

interface Props {
  tab: TabState;
  /** Fraction of the context window at which auto-compact kicks in. */
  autoCompactThreshold: number;
  /** The app's default model/effort for this tab's provider, so the
   *  composer's pickers can name what "default" gets. Empty = provider's own. */
  defaultModel: string;
  defaultEffort: string;
  sidebarView: SidebarView | null;
  onSelectSidebarView: (view: SidebarView | null) => void;
  /** Which right-hand panel is showing. Lifted for the same reason
   *  `sidebarView` is: this component remounts on every project switch. */
  rightPanel: RightPanel;
  onSelectRightPanel: (panel: RightPanel) => void;
  shells: ShellsView;
  onOpenSettings: () => void;
  /** Resolves with the instant local listing; `onRefresh` delivers the
   *  merged native listing later, when a live agent could be asked. */
  loadHistory: (onRefresh: (listing: HistoryListing) => void) => Promise<HistoryListing>;
  onOpenSession: (item: HistoryItem) => Promise<void>;
  onDeleteSession: (sessionId: string) => Promise<void>;
  onNewChat: () => void;
  onSend: (prompt: string, attachments: readonly string[]) => void;
  onDraftChange: (draft: string, attachments: readonly string[]) => void;
  onRemoveQueued: (index: number) => void;
  onCancel: () => void;
  onSelectProvider: (provider: ProviderId) => void;
  onSelectMode: (mode: AgentMode) => void;
  onSelectPermission: (permission: PermissionPolicy) => void;
  onSelectModel: (model: string) => void;
  onSelectEffort: (effort: string) => void;
  /** Respawn the agent now to apply the deferred model/effort change. */
  onApplyPendingSpec: () => void;
  onDiscardPendingSpec: () => void;
  /** Compact the conversation now, when the user was asked and chose to. */
  onCompactNow: () => void;
  onDismissContextFull: () => void;
  onToggleVerbose: (verbose: boolean) => void;
  onRespondPermission: (requestId: string, optionId: string) => void;
  onAnswerQuestion: (requestId: string, answers: Record<string, string>) => void;
  onRetry: () => void;
  /** Open the provider's login prompt, offered on a sign-in failure. */
  onSignIn: () => void;
  loadCommands: () => Promise<CommandInfo[]>;
  loadGitChanges: () => Promise<GitChanges | null>;
  onGitStage: (path: string) => Promise<GitActionResult>;
  onGitUnstage: (path: string) => Promise<GitActionResult>;
  onGitCommitPush: (message: string) => Promise<GitActionResult>;
  onGitCheckout: (branch: string) => Promise<GitActionResult>;
  onGitPush: () => Promise<GitActionResult>;
  onGitPull: () => Promise<GitActionResult>;
  onGitFetch: () => Promise<GitActionResult>;
  onGitDiff: (
    path: string,
    staged: boolean,
    untracked: boolean,
  ) => Promise<GitActionResult>;
  /** The repo's checkouts, for the worktree picker. */
  loadWorktrees: () => Promise<WorktreeItem[]>;
  onOpenWorktree: (path: string, mainPath: string) => void;
  onCreateWorktree: (branch: string, mode: WorktreeAddMode) => Promise<GitActionResult>;
  /** Try the heavy-folder copy again after it failed. */
  onRetryPreparing: () => void;
  onCheckWorktreeRemoval: (path: string) => Promise<RemovalCheck>;
  onRemoveWorktree: (path: string, mode: WorktreeRemoveMode) => Promise<GitActionResult>;
  onOpenFile: (path: string) => Promise<string | null>;
  onPickFiles: () => Promise<string[]>;
  /** Save an image pasted into the composer; returns its file path. */
  onPasteImage: (bytes: Uint8Array, mimeType: string) => Promise<string>;
  /** The project's files, for the composer's "@" menu. */
  loadProjectFiles: () => Promise<string[]>;
  /** Read an agent-owned terminal's live output. Stable identity. */
  onReadTerminal: (
    terminalId: string,
  ) => Promise<{ output: string; truncated: boolean; exited: boolean } | null>;
}

/** UI — the chat for one project: header, transcript, plan, composer. */
export function ChatPanel({
  tab,
  autoCompactThreshold,
  defaultModel,
  defaultEffort,
  sidebarView,
  onSelectRightPanel,
  rightPanel,
  shells,
  onSelectSidebarView,
  onOpenSettings,
  loadHistory,
  onOpenSession,
  onDeleteSession,
  onNewChat,
  onSend,
  onDraftChange,
  onRemoveQueued,
  onCancel,
  onSelectProvider,
  onSelectMode,
  onSelectPermission,
  onSelectModel,
  onSelectEffort,
  onApplyPendingSpec,
  onDiscardPendingSpec,
  onCompactNow,
  onDismissContextFull,
  onToggleVerbose,
  onRespondPermission,
  onAnswerQuestion,
  onRetry,
  onSignIn,
  loadCommands,
  loadGitChanges,
  onGitStage,
  onGitUnstage,
  onGitCommitPush,
  onGitCheckout,
  onGitPush,
  onGitPull,
  onGitFetch,
  onGitDiff,
  loadWorktrees,
  onOpenWorktree,
  onCreateWorktree,
  onRetryPreparing,
  onCheckWorktreeRemoval,
  onRemoveWorktree,
  onOpenFile,
  onPickFiles,
  onPasteImage,
  loadProjectFiles,
  onReadTerminal,
}: Props) {
  const providerName = providerById(tab.project.provider).displayName;
  const [fallbackCommands, setFallbackCommands] = useState<readonly CommandInfo[]>([]);
  const [changes, setChanges] = useState<GitChanges | null>(null);
  const [changesRefreshKey, setChangesRefreshKey] = useState(0);
  const [history, setHistory] = useState<HistoryListing>({ native: false, sessions: [] });
  const [historyLoading, setHistoryLoading] = useState(false);
  const sidebar = useDragWidth(270, 180, 520);
  const planPanel = useDragWidth(420, 280, 760, "left");
  const terminalPanel = useDragWidth(520, 320, 900, "left");
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [worktreePickerOpen, setWorktreePickerOpen] = useState(false);
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);

  const currentBranch = changes?.branches.find((b) => b.current)?.name;

  // Reaches memoized transcript rows — must not be a fresh arrow per render.
  const showPlan = useCallback(() => onSelectRightPanel("plan"), [onSelectRightPanel]);
  const closeRightPanel = useCallback(
    () => onSelectRightPanel(null),
    [onSelectRightPanel],
  );
  const toggleTerminal = useCallback(
    () => onSelectRightPanel(rightPanel === "terminal" ? null : "terminal"),
    [onSelectRightPanel, rightPanel],
  );
  const showAgentDiff = useCallback(
    (diff: { path: string; oldText?: string; newText: string }) =>
      setDiffTarget({ kind: "agent", ...diff }),
    [],
  );
  const openTouchedFile = useCallback(
    (path: string) => void onOpenFile(path),
    [onOpenFile],
  );

  // Bumps every time the agent runs a tool that could touch the tree.
  // Keyed on length, not the array: deltas replace the array per token
  // but only ever mutate the LAST message's text; tool rows always add
  // a message, so length is the sufficient (and cheap) dependency.
  const messageCount = tab.messages.length;
  const fileChangingTools = useMemo(
    () => countFileChangingTools(tab.messages),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messageCount],
  );

  // What the agent said it edited — first-hand data for the Changes
  // panel, next to (not instead of) what git reports.
  const agentEdits = useMemo(
    () => agentEditedFiles(tab.messages),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [messageCount, fileChangingTools],
  );

  // The running agent's own command list is the source of truth; the
  // static + discovered set covers the time before a session starts.
  const commands = tab.agentCommands.length > 0 ? tab.agentCommands : fallbackCommands;

  // Stable identity: this reaches memoized transcript rows, so a fresh
  // Set every render would defeat their memo.
  const commandNameSet = useMemo(() => commandNames(commands), [commands]);

  useEffect(() => {
    let cancelled = false;
    loadCommands().then((loaded) => {
      if (!cancelled) setFallbackCommands(loaded);
    });
    return () => {
      cancelled = true;
    };
    // Reload when the tab's provider changes; loadCommands is stable per tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.project.provider, tab.project.id]);

  // Reload git whenever the working tree may have moved: a turn starting
  // or ending, the running agent touching files, or the user asking.
  // Reading git is safe mid-turn, so this stays live while the agent
  // works. Debounced, so a burst of edits costs one `git status`.
  // Loaded even with the panel closed, so the header branch stays live.
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      loadGitChanges().then((loaded) => {
        if (!cancelled) setChanges(loaded);
      });
    }, GIT_RELOAD_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.busy, tab.project.id, changesRefreshKey, fileChangingTools]);

  // Refresh the session list when the history view is open and the tab
  // is idle (a finished turn may have added or updated a session). The
  // local listing paints first; the agent's native listing, when a live
  // session can be asked, lands as a second update.
  useEffect(() => {
    if (sidebarView !== "history" || tab.busy) return;
    let cancelled = false;
    let refreshed = false;
    setHistoryLoading(true);
    loadHistory((merged) => {
      if (cancelled) return;
      refreshed = true;
      setHistory(merged);
      setHistoryLoading(false);
    }).then((loaded) => {
      // The merged listing may already have landed — a stale local
      // paint must not overwrite it.
      if (cancelled || refreshed) return;
      setHistory(loaded);
      setHistoryLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarView, tab.busy, tab.project.id]);

  // Ctrl+` — the binding every editor uses for this. Registered here
  // rather than in a global map because the app has no shortcut registry
  // and one panel does not justify inventing one.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "`" || !(e.ctrlKey || e.metaKey) || e.altKey) return;
      e.preventDefault();
      toggleTerminal();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [toggleTerminal]);

  return (
    <main className="chat-panel">
      <div className="chat-panel__header">
        <span className="chat-panel__path" title={tab.project.path}>
          {tab.project.path}
        </span>
        {currentBranch && (
          <button
            type="button"
            className="branch-chip"
            title="Checkout a branch"
            onClick={() => setBranchPickerOpen(true)}
          >
            <GitBranch size={12} aria-hidden="true" />
            {currentBranch}
          </button>
        )}
        {tab.preparing && (
          <span
            className="worktree-preparing"
            title="Copying this worktree's dependencies and build folders into place."
          >
            Preparing…
          </span>
        )}
        {tab.preparingProblem && (
          <button
            type="button"
            className="worktree-preparing worktree-preparing--failed"
            title={`${tab.preparingProblem} — click to try again.`}
            onClick={onRetryPreparing}
          >
            Not prepared
          </button>
        )}
        <div className="chat-panel__controls">
          {currentBranch && (
            <button
              type="button"
              className="branch-chip"
              title="Open or create a worktree"
              onClick={() => setWorktreePickerOpen(true)}
            >
              <GitFork size={12} aria-hidden="true" />
              Worktrees
            </button>
          )}
          <button
            type="button"
            className="new-chat-button"
            disabled={tab.busy}
            title="New chat — clears the screen AND starts a fresh agent context"
            onClick={onNewChat}
          >
            <NotePencil size={14} aria-hidden="true" />
            New chat
          </button>
          <label
            className="verbose-toggle"
            title="Verbose: show tool activity, thoughts, and status rows. Off: only the conversation."
          >
            Verbose
            <input
              type="checkbox"
              role="switch"
              aria-checked={tab.project.verbose}
              className="switch__input"
              checked={tab.project.verbose}
              onChange={(e) => onToggleVerbose(e.target.checked)}
            />
            <span className="switch" aria-hidden="true" />
          </label>
          <button
            type="button"
            className={`icon-button ${rightPanel === "terminal" ? "icon-button--on" : ""}`}
            aria-label="Terminal"
            aria-pressed={rightPanel === "terminal"}
            title="Terminal (Ctrl+`)"
            onClick={toggleTerminal}
          >
            <TerminalWindow size={16} />
          </button>
          <ProviderPicker
            value={tab.project.provider}
            disabled={tab.busy}
            onChange={onSelectProvider}
          />
        </div>
      </div>
      <div className="chat-panel__body">
        <ActivityBar
          active={sidebarView}
          onSelect={onSelectSidebarView}
          onOpenSettings={onOpenSettings}
        />
        {sidebarView && (
          <>
            <div style={{ width: sidebar.width }} className="changes-container">
              {sidebarView === "changes" && (
                <ChangesPanel
                  changes={changes}
                  busy={tab.busy}
                  agentEdits={agentEdits}
                  onShowAgentDiff={showAgentDiff}
                  onStage={onGitStage}
                  onUnstage={onGitUnstage}
                  onCommitPush={onGitCommitPush}
                  onOpenBranchPicker={() => setBranchPickerOpen(true)}
                  onPush={onGitPush}
                  onPull={onGitPull}
                  onFetch={onGitFetch}
                  onRefresh={() => setChangesRefreshKey((k) => k + 1)}
                  onOpenFile={onOpenFile}
                  onShowDiff={(file, staged) =>
                    setDiffTarget({
                      kind: "git",
                      path: file.path,
                      staged,
                      untracked: file.label === "untracked",
                    })
                  }
                />
              )}
              {sidebarView === "history" && (
                <HistoryPanel
                  sessions={history.sessions}
                  native={history.native}
                  loading={historyLoading}
                  error={history.error}
                  activeSessionId={tab.historySessionId}
                  busy={tab.busy}
                  onOpen={(item) => void onOpenSession(item)}
                  onDelete={(id) =>
                    void onDeleteSession(id).then(() =>
                      setHistory({
                        ...history,
                        sessions: history.sessions.filter((s) => s.id !== id),
                      }),
                    )
                  }
                  onNewChat={onNewChat}
                />
              )}
            </div>
            <div
              className="panel-resizer"
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize"
              onPointerDown={sidebar.startResize}
            />
          </>
        )}
        <div className="chat-panel__main">
          <PlanBar plan={tab.plan} planMarkdown={tab.planMarkdown} onOpen={showPlan} />
          <MessageList
            messages={tab.messages}
            busy={tab.busy}
            turnStartedAt={tab.turnStartedAt}
            sessionStage={tab.sessionStage}
            onRetry={onRetry}
            onSignIn={onSignIn}
            onOpenFile={openTouchedFile}
            onShowAgentDiff={showAgentDiff}
            onReadTerminal={onReadTerminal}
            commands={commandNameSet}
            verbose={tab.project.verbose}
            onRespondPermission={onRespondPermission}
            onAnswerQuestion={onAnswerQuestion}
            onShowPlan={showPlan}
          />
          {tab.contextFullPercent !== undefined && (
            <ContextFullBar
              percent={tab.contextFullPercent}
              contextTokens={tab.usage?.used}
              onCompact={onCompactNow}
              onNewChat={onNewChat}
              onDismiss={onDismissContextFull}
            />
          )}
          {tab.pendingSpec && (
            <PendingSpecBar
              pending={tab.pendingSpec}
              contextTokens={tab.usage?.used}
              onApplyNow={onApplyPendingSpec}
              onDiscard={onDiscardPendingSpec}
            />
          )}
          <Composer
            busy={tab.busy}
            draft={tab.draft ?? ""}
            attachments={tab.draftAttachments ?? EMPTY_ATTACHMENTS}
            onDraftChange={onDraftChange}
            queued={tab.queued}
            onRemoveQueued={onRemoveQueued}
            placeholder={`Ask ${providerName} about ${tab.project.name}… (/ for commands, @ for files)`}
            commands={commands}
            provider={tab.project.provider}
            mode={tab.project.mode}
            permission={tab.project.permission}
            model={tab.project.model ?? ""}
            effort={tab.project.effort ?? ""}
            defaultModel={defaultModel}
            defaultEffort={defaultEffort}
            usage={tab.usage}
            autoCompactThreshold={autoCompactThreshold}
            onSend={onSend}
            onCancel={onCancel}
            onPickFiles={onPickFiles}
            onPasteImage={onPasteImage}
            loadProjectFiles={loadProjectFiles}
            onSelectMode={onSelectMode}
            onSelectPermission={onSelectPermission}
            onSelectModel={onSelectModel}
            onSelectEffort={onSelectEffort}
            pendingSpec={tab.pendingSpec}
          />
        </div>
        {rightPanel && (
          <div
            className="panel-resizer"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize"
            onPointerDown={
              rightPanel === "plan" ? planPanel.startResize : terminalPanel.startResize
            }
          />
        )}
        {rightPanel === "plan" && (
          <PlanSidePanel
            plan={tab.plan}
            planMarkdown={tab.planMarkdown}
            width={planPanel.width}
            onExpand={() => setPlanModalOpen(true)}
            onClose={closeRightPanel}
          />
        )}
        {rightPanel === "terminal" && (
          <TerminalPanel
            sessions={tab.shells}
            activeShellId={tab.activeShellId}
            width={terminalPanel.width}
            fontSize={shells.fontSize}
            theme={shells.theme}
            onOpen={shells.open}
            onWrite={shells.write}
            onAcceptSuggestion={shells.acceptSuggestion}
            onResize={shells.resize}
            onSelect={shells.select}
            onClose={shells.close}
            onClosePanel={closeRightPanel}
          />
        )}
      </div>
      {planModalOpen && (
        <PlanModal
          plan={tab.plan}
          planMarkdown={tab.planMarkdown}
          onClose={() => setPlanModalOpen(false)}
        />
      )}
      {diffTarget && (
        <DiffModal
          key={
            diffTarget.kind === "git"
              ? `git:${diffTarget.path}:${diffTarget.staged}`
              : `agent:${diffTarget.path}`
          }
          path={diffTarget.path}
          source={
            diffTarget.kind === "git"
              ? {
                  kind: "git",
                  staged: diffTarget.staged,
                  load: () =>
                    onGitDiff(diffTarget.path, diffTarget.staged, diffTarget.untracked),
                }
              : {
                  kind: "agent",
                  oldText: diffTarget.oldText,
                  newText: diffTarget.newText,
                }
          }
          onClose={() => setDiffTarget(null)}
        />
      )}
      {branchPickerOpen && changes && (
        <BranchPicker
          branches={changes.branches}
          onPick={async (branch) => {
            const result = await onGitCheckout(branch);
            // Re-read git BEFORE handing the outcome back: the picker
            // closes on success, and it must close onto the branch the
            // user just chose — header, tab bar and file list included.
            // The debounced background refresh is too late for that.
            if (result.ok) setChanges(await loadGitChanges());
            return result;
          }}
          onClose={() => setBranchPickerOpen(false)}
        />
      )}
      {worktreePickerOpen && (
        <WorktreePicker
          loadWorktrees={loadWorktrees}
          branches={changes?.branches ?? []}
          currentBranch={currentBranch ?? ""}
          onOpen={onOpenWorktree}
          onCreate={onCreateWorktree}
          onCheckRemoval={onCheckWorktreeRemoval}
          onRemove={onRemoveWorktree}
          onClose={() => setWorktreePickerOpen(false)}
        />
      )}
    </main>
  );
}
