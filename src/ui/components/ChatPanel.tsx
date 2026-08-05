import { useCallback, useEffect, useMemo, useState } from "react";
import type { AgentMode, PermissionPolicy } from "../../core/entities/agentSettings";
import { type CommandInfo, commandNames } from "../../core/entities/command";
import type { ProviderId } from "../../core/entities/provider";
import { providerById } from "../../core/entities/provider";
import { agentEditedFiles, countFileChangingTools } from "../../core/entities/tool";
import type { TabState } from "../../core/state/appState";
import type { GitActionResult } from "../../core/usecases/gitActions";
import type { HistoryListing } from "../../core/usecases/history";
import type { GitChanges } from "../../core/usecases/loadGitChanges";
import { useDragWidth } from "../useDragWidth";
import { ActivityBar, type SidebarView } from "./ActivityBar";
import { BranchPicker } from "./BranchPicker";
import { ChangesPanel } from "./ChangesPanel";
import { Composer } from "./Composer";
import { DiffModal } from "./DiffModal";
import { HistoryPanel } from "./HistoryPanel";
import { MessageList } from "./MessageList";
import { PlanBar, PlanSidePanel } from "./PlanPanel";
import { ProviderPicker } from "./ProviderPicker";

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
  sidebarView: SidebarView | null;
  onSelectSidebarView: (view: SidebarView | null) => void;
  onOpenSettings: () => void;
  loadHistory: () => Promise<HistoryListing>;
  onOpenSession: (sessionId: string, native: boolean) => Promise<void>;
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
  onToggleVerbose: (verbose: boolean) => void;
  onRespondPermission: (requestId: string, optionId: string) => void;
  onAnswerQuestion: (requestId: string, answers: Record<string, string>) => void;
  onRetry: () => void;
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
  onOpenFile: (path: string) => Promise<string | null>;
  onPickFiles: () => Promise<string[]>;
  /** Read an agent-owned terminal's live output. Stable identity. */
  onReadTerminal: (
    terminalId: string,
  ) => Promise<{ output: string; truncated: boolean; exited: boolean } | null>;
}

/** UI — the chat for one project: header, transcript, plan, composer. */
export function ChatPanel({
  tab,
  sidebarView,
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
  onToggleVerbose,
  onRespondPermission,
  onAnswerQuestion,
  onRetry,
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
  onOpenFile,
  onPickFiles,
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
  const [branchPickerOpen, setBranchPickerOpen] = useState(false);
  const [planOpen, setPlanOpen] = useState(false);
  const [diffTarget, setDiffTarget] = useState<DiffTarget | null>(null);

  const currentBranch = changes?.branches.find((b) => b.current)?.name;

  // Reaches memoized transcript rows — must not be a fresh arrow per render.
  const showPlan = useCallback(() => setPlanOpen(true), []);
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
  // is idle (a finished turn may have added or updated a session).
  useEffect(() => {
    if (sidebarView !== "history" || tab.busy) return;
    let cancelled = false;
    setHistoryLoading(true);
    loadHistory().then((loaded) => {
      if (cancelled) return;
      setHistory(loaded);
      setHistoryLoading(false);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sidebarView, tab.busy, tab.project.id]);

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
            {currentBranch}
          </button>
        )}
        <div className="chat-panel__controls">
          <label
            className="verbose-toggle"
            title="Verbose: show tool activity, thoughts, and status rows. Off: only the conversation."
          >
            <input
              type="checkbox"
              checked={tab.project.verbose}
              onChange={(e) => onToggleVerbose(e.target.checked)}
            />
            Verbose
          </label>
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
                  onOpen={(id) => void onOpenSession(id, history.native)}
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
            onOpenFile={openTouchedFile}
            onShowAgentDiff={showAgentDiff}
            onReadTerminal={onReadTerminal}
            commands={commandNameSet}
            verbose={tab.project.verbose}
            onRespondPermission={onRespondPermission}
            onAnswerQuestion={onAnswerQuestion}
            onShowPlan={showPlan}
          />
          <Composer
            busy={tab.busy}
            draft={tab.draft ?? ""}
            attachments={tab.draftAttachments ?? EMPTY_ATTACHMENTS}
            onDraftChange={onDraftChange}
            queued={tab.queued}
            onRemoveQueued={onRemoveQueued}
            placeholder={`Ask ${providerName} about ${tab.project.name}… (type / for commands)`}
            commands={commands}
            provider={tab.project.provider}
            mode={tab.project.mode}
            permission={tab.project.permission}
            model={tab.project.model ?? ""}
            effort={tab.project.effort ?? ""}
            usage={tab.usage}
            onSend={onSend}
            onCancel={onCancel}
            onPickFiles={onPickFiles}
            onSelectMode={onSelectMode}
            onSelectPermission={onSelectPermission}
            onSelectModel={onSelectModel}
            onSelectEffort={onSelectEffort}
          />
        </div>
        {planOpen && (
          <>
            <div
              className="panel-resizer"
              role="separator"
              aria-orientation="vertical"
              title="Drag to resize"
              onPointerDown={planPanel.startResize}
            />
            <PlanSidePanel
              plan={tab.plan}
              planMarkdown={tab.planMarkdown}
              width={planPanel.width}
              onClose={() => setPlanOpen(false)}
            />
          </>
        )}
      </div>
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
          onPick={(branch) => {
            void onGitCheckout(branch).then(() => setChangesRefreshKey((k) => k + 1));
          }}
          onClose={() => setBranchPickerOpen(false)}
        />
      )}
    </main>
  );
}
