import type { Icon } from "@phosphor-icons/react";
import {
  ArrowClockwise,
  ArrowLineDown,
  ArrowLineUp,
  ArrowSquareOut,
  ArrowsClockwise,
  CaretDown,
  CaretRight,
  Check,
  CircleNotch,
  DotsThree,
  GitBranch,
  GitDiff,
  Minus,
  Plus,
  Trash,
  X,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { commitUrl } from "../../core/entities/gitRemote";
import type { AgentEditedFile } from "../../core/entities/tool";
import type { GitChange } from "../../core/ports/gitPort";
import type { GitActionResult, GitVerb } from "../../core/usecases/gitActions";
import type { GitChanges } from "../../core/usecases/loadGitChanges";
import { openExternalLink } from "../externalLink";
import { fileName, parentDir } from "../fileName";
import { ConfirmDialog } from "./ConfirmDialog";
import type { AgentDiff } from "./ToolCallContentView";

interface Props {
  changes: GitChanges | null;
  busy: boolean;
  /** The git verb running against this project, from the tab's state —
   *  the panel is remounted on every tab switch and cannot hold it. */
  working: GitVerb | null;
  /** What the last verb said, from the same place and for the reason. */
  notice: GitActionResult | null;
  /** Files the agent itself reported editing this session (first-hand,
   *  unlike the git sections below). */
  agentEdits: readonly AgentEditedFile[];
  onStage: (path: string) => Promise<GitActionResult>;
  onUnstage: (path: string) => Promise<GitActionResult>;
  onStageAll: () => Promise<GitActionResult>;
  onUnstageAll: () => Promise<GitActionResult>;
  /** Throw one file's unstaged changes away. Cannot be undone. */
  onDiscard: (path: string) => Promise<GitActionResult>;
  /** The same for every unstaged change at once. */
  onDiscardAll: () => Promise<GitActionResult>;
  onCommitPush: (message: string) => Promise<GitActionResult>;
  onOpenBranchPicker: () => void;
  onPush: () => Promise<GitActionResult>;
  onPull: () => Promise<GitActionResult>;
  onFetch: () => Promise<GitActionResult>;
  onRefresh: () => void;
  /** Open a changed file in the OS's editor for that type. */
  onOpenFile: (path: string) => Promise<string | null>;
  /** Show the file's diff in a modal. */
  onShowDiff: (file: GitChange, staged: boolean) => void;
  /** Show every edit the agent reported for one file in the modal. */
  onShowAgentDiff: (diff: AgentDiff) => void;
}

/** Which sections start open — the git ones; agent edits is a review
 *  extra (it survives commits), so it starts folded out of the way. */
const ALL_OPEN = { agent: false, staged: true, unstaged: true, commits: true };

/** Stands in for a path in `confirming` when the whole section is meant.
 *  A path, so it cannot collide with a real one: git has no file at "."
 *  and would refuse to name one. */
const DISCARD_ALL = ".";

/**
 * UI — the project's source control, VS-style: fetch/pull/push, staged
 * and not-staged files with one-click (un)stage, and the recent commits.
 * Every section collapses, because a repo mid-refactor can list more
 * files than the sidebar is tall.
 */
export function ChangesPanel({
  changes,
  busy,
  working,
  notice,
  agentEdits,
  onStage,
  onUnstage,
  onStageAll,
  onUnstageAll,
  onDiscard,
  onDiscardAll,
  onCommitPush,
  onOpenBranchPicker,
  onPush,
  onPull,
  onFetch,
  onRefresh,
  onOpenFile,
  onShowDiff,
  onShowAgentDiff,
}: Props) {
  // Opening a file is the panel's own business — no git, no tab state.
  const [fileProblem, setFileProblem] = useState<GitActionResult | null>(null);
  const [dismissed, setDismissed] = useState<GitActionResult | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [open, setOpen] = useState(ALL_OPEN);
  // The discard waiting on an answer: a path, or "all". Discarding is
  // the only thing this panel does that git cannot undo — there is no
  // stash and no reflog behind it — so it is the only thing it asks
  // about first.
  const [confirming, setConfirming] = useState<string | null>(null);

  const toggle = (section: keyof typeof ALL_OPEN) =>
    setOpen((current) => ({ ...current, [section]: !current[section] }));

  // The verb, its outcome and the reread it earns all hang off the tab's
  // state now — a verb outliving this panel still finishes properly.
  const run = async (
    action: () => Promise<GitActionResult>,
  ): Promise<GitActionResult> => {
    setFileProblem(null);
    return action();
  };

  // Opening a file changes nothing in the repo, so it neither disables
  // the panel nor triggers a refresh — but a failure must still be said.
  const openFile = async (path: string) => {
    const error = await onOpenFile(path);
    setFileProblem(error ? { ok: false, message: error } : null);
  };

  // Reading git is safe while the agent works; moving the index under it
  // is not. Only the refresh stays live.
  const mutationsDisabled = busy || working !== null;
  const currentBranch = changes?.branches.find((b) => b.current)?.name ?? "";
  // Counted against the last fetch — the numbers move when Fetch runs,
  // not when the remote does.
  const behind = changes?.divergence?.behind ?? 0;
  const ahead = changes?.divergence?.ahead ?? 0;
  const canCommit =
    !mutationsDisabled &&
    (changes?.staged.length ?? 0) > 0 &&
    commitMessage.trim() !== "";

  const commitPush = async () => {
    const result = await run(() => onCommitPush(commitMessage));
    if (result.ok) setCommitMessage("");
  };

  /** The verb's icon, swapped for a spinner while that verb runs. */
  const verbIcon = (verb: GitVerb, Idle: Icon) =>
    working === verb ? <CircleNotch className="changes__watching" /> : <Idle />;

  // A notice stays until it is dismissed or replaced. Remembering the
  // dismissed object rather than a flag is what makes the next notice
  // appear on its own: a new result is a different object, so nothing
  // has to reset anything when one arrives.
  const latest = fileProblem ?? notice;
  const shown = latest && latest !== dismissed ? latest : null;

  // Rendered below "Not staged" (or under the no-repo notice: the agent
  // reports its edits even where git can't).
  const agentSection = agentEdits.length > 0 && (
    <Section
      title="Agent edits"
      count={agentEdits.length}
      open={open.agent}
      onToggle={() => toggle("agent")}
    >
      <ul className="changes__list">
        {agentEdits.map((file) => (
          <li key={file.path} className="changes__item" title={file.path}>
            <span className="changes__badge changes__badge--agent">
              <GitDiff size={12} />
            </span>
            <button
              type="button"
              className="changes__file"
              title={
                file.edits.length > 0
                  ? `Show the agent's ${editCount(file.edits.length)} to ${file.path}`
                  : `Open ${file.path}`
              }
              onClick={() =>
                file.edits.length > 0
                  ? onShowAgentDiff({ path: file.path, edits: file.edits })
                  : void onOpenFile(file.path)
              }
            >
              <span className="changes__filename">{fileName(file.path)}</span>
              {parentDir(file.path) && (
                <span className="changes__dir">{parentDir(file.path)}</span>
              )}
              {/* One edit is the unremarkable case and stays quiet; more
                  than one says so, since the row opens all of them. */}
              {file.edits.length > 1 && (
                <span className="changes__edits">×{file.edits.length}</span>
              )}
            </button>
          </li>
        ))}
      </ul>
    </Section>
  );

  return (
    <aside className="changes">
      {changes && changes.branches.length > 0 && (
        <button
          type="button"
          className="changes__branch"
          disabled={mutationsDisabled}
          title="Checkout a branch"
          onClick={onOpenBranchPicker}
        >
          <GitBranch />
          {currentBranch}
          <CaretDown className="changes__branch-chevron" />
        </button>
      )}
      <div className="changes__actions">
        <button
          type="button"
          className="changes__action"
          // Fetch moves no files, so it is safe even mid-turn — the only
          // remote verb the running agent can't be disturbed by.
          disabled={working !== null}
          aria-label="Fetch"
          title="Fetch and prune remote-tracking branches"
          onClick={() => void run(onFetch)}
        >
          {verbIcon("fetch", ArrowsClockwise)}
        </button>
        <button
          type="button"
          className="changes__action"
          disabled={mutationsDisabled}
          aria-label="Pull"
          title={pendingTitle("pull", behind)}
          onClick={() => void run(onPull)}
        >
          {verbIcon("pull", ArrowLineDown)}
          <PendingCount count={behind} />
        </button>
        <button
          type="button"
          className="changes__action"
          disabled={mutationsDisabled}
          aria-label="Push"
          title={pendingTitle("push", ahead)}
          onClick={() => void run(onPush)}
        >
          {verbIcon("push", ArrowLineUp)}
          <PendingCount count={ahead} />
        </button>
        <button
          type="button"
          className="changes__action changes__action--icon"
          disabled={working !== null}
          aria-label="Refresh git status"
          title={
            busy ? "Watching the agent's changes live — click to refresh now" : "Refresh"
          }
          onClick={onRefresh}
        >
          <ArrowClockwise className={busy ? "changes__watching" : undefined} />
        </button>
      </div>

      <div className="changes__commit">
        <input
          className="changes__commit-message"
          value={commitMessage}
          placeholder="Commit message"
          disabled={mutationsDisabled}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canCommit) void commitPush();
          }}
        />
        <button
          type="button"
          className="changes__action changes__action--commit"
          disabled={!canCommit}
          title="Commit staged changes and push"
          onClick={() => void commitPush()}
        >
          {verbIcon("commit", Check)} Commit & Push
        </button>
      </div>

      {shown && (
        <p className={`changes__notice ${shown.ok ? "" : "changes__notice--error"}`}>
          <span className="changes__notice-text">{shown.message}</span>
          <button
            type="button"
            className="changes__notice-dismiss"
            aria-label="Dismiss this message"
            title="Dismiss"
            onClick={() => setDismissed(shown)}
          >
            <X size={12} />
          </button>
        </p>
      )}

      {!changes ? (
        <>
          <p className="changes__empty">Not a git repository (or git isn't installed).</p>
          {agentSection}
        </>
      ) : (
        <>
          {changes.staged.length === 0 && changes.unstaged.length === 0 && (
            <p className="changes__empty">Working tree clean.</p>
          )}
          <Section
            title="Staged"
            count={changes.staged.length}
            open={open.staged}
            onToggle={() => toggle("staged")}
            action={
              <SectionAction
                label="Unstage all"
                Icon={Minus}
                disabled={mutationsDisabled}
                onClick={() => void run(onUnstageAll)}
              />
            }
          >
            <ChangeList
              files={changes.staged}
              ActionIcon={Minus}
              actionTitle="Unstage"
              disabled={mutationsDisabled}
              onAction={(path) => void run(() => onUnstage(path))}
              onOpenFile={(path) => void openFile(path)}
              onShowDiff={(file) => onShowDiff(file, true)}
            />
          </Section>
          <Section
            title="Not staged"
            count={changes.unstaged.length}
            open={open.unstaged}
            onToggle={() => toggle("unstaged")}
            action={
              <>
                <SectionAction
                  label="Discard all"
                  Icon={Trash}
                  danger
                  disabled={mutationsDisabled || changes.unstaged.length === 0}
                  onClick={() => setConfirming(DISCARD_ALL)}
                />
                <SectionAction
                  label="Stage all"
                  Icon={Plus}
                  disabled={mutationsDisabled}
                  onClick={() => void run(onStageAll)}
                />
              </>
            }
          >
            <ChangeList
              files={changes.unstaged}
              ActionIcon={Plus}
              actionTitle="Stage"
              disabled={mutationsDisabled}
              onAction={(path) => void run(() => onStage(path))}
              onDiscard={(path) => setConfirming(path)}
              onOpenFile={(path) => void openFile(path)}
              onShowDiff={(file) => onShowDiff(file, false)}
            />
          </Section>
          {agentSection}
          <Section
            title="Recent commits"
            count={changes.commits.length}
            open={open.commits}
            onToggle={() => toggle("commits")}
          >
            <ul className="changes__list">
              {changes.commits.map((commit) => {
                const url = commitUrl(changes.remote, commit.hash);
                const label = `${commit.subject}\n${commit.author} — ${commit.when}`;
                return (
                  <li key={commit.hash}>
                    <button
                      type="button"
                      className={`commit ${url ? "commit--link" : ""}`}
                      disabled={!url}
                      title={url ? `${label}\nOpen on the remote` : label}
                      onClick={() => url && openExternalLink(url)}
                    >
                      <span className="commit__hash">{commit.hash}</span>
                      <span className="commit__subject">{commit.subject}</span>
                      <span className="commit__when">{commit.when}</span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </Section>
        </>
      )}
      {confirming !== null && (
        <ConfirmDialog
          title={confirming === DISCARD_ALL ? "Discard all changes?" : "Discard changes?"}
          message={
            confirming === DISCARD_ALL
              ? discardAllMessage(changes?.unstaged ?? [])
              : discardFileMessage(confirming, changes?.unstaged ?? [])
          }
          detail={
            confirming === DISCARD_ALL
              ? (changes?.unstaged ?? []).map((file) => ({
                  id: file.path,
                  label: `${file.path} — ${file.label}`,
                }))
              : undefined
          }
          confirmLabel="Discard"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            const target = confirming;
            setConfirming(null);
            void run(() => (target === DISCARD_ALL ? onDiscardAll() : onDiscard(target)));
          }}
        />
      )}
    </aside>
  );
}

/**
 * What discarding this one file does — which is not one thing.
 *
 * An untracked file has no earlier version to go back to, so discarding
 * it deletes it. Saying "goes back to its last staged state" there would
 * describe the opposite of what happens.
 */
function discardFileMessage(path: string, unstaged: readonly GitChange[]): string {
  const untracked = unstaged.find((file) => file.path === path)?.label === "untracked";
  return untracked
    ? `${path} is new — discarding deletes it. This cannot be undone.`
    : `${path} goes back to its last staged state. This cannot be undone.`;
}

/**
 * What "discard all" is about to cost, counted rather than implied.
 *
 * Untracked files are named separately because their fate is different
 * in kind: a modified file goes back to what it was, an untracked one
 * stops existing. Nobody should learn that distinction afterwards.
 */
function discardAllMessage(unstaged: readonly GitChange[]): string {
  const untracked = unstaged.filter((file) => file.label === "untracked").length;
  const edited = unstaged.length - untracked;
  const parts: string[] = [];
  if (edited > 0) {
    parts.push(`${edited} edited ${edited === 1 ? "file goes" : "files go"} back`);
  }
  if (untracked > 0) {
    parts.push(`${untracked} new ${untracked === 1 ? "file is" : "files are"} deleted`);
  }
  return `${parts.join(", ")}. Staged changes and ignored files are left alone. This cannot be undone.`;
}

/** The commits a verb has waiting, on its button; nothing at zero, so a
 *  branch in sync stays quiet. */
function PendingCount({ count }: { count: number }) {
  if (count === 0) return null;
  return <span className="changes__pending">{count}</span>;
}

/** What the Pull/Push button promises, said in commits. "Since the last
 *  fetch" is not pedantry: these counts come from local refs, so a
 *  branch can read as in sync while the remote has moved on. */
function pendingTitle(verb: "pull" | "push", count: number): string {
  const commits = `${String(count)} ${count === 1 ? "commit" : "commits"}`;
  if (verb === "pull") {
    return count === 0
      ? "Pull — nothing new since the last fetch"
      : `Pull ${commits} from the upstream (as of the last fetch)`;
  }
  return count === 0
    ? "Push — nothing waiting to be pushed"
    : `Push ${commits} to the upstream`;
}

/** A titled, collapsible group with its item count in the header, and
 *  optionally one button acting on the whole group. */
function Section({
  title,
  count,
  open,
  onToggle,
  action,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
  action?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="changes__group">
      <h3 className="changes__title">
        <button
          type="button"
          className="changes__title-toggle"
          aria-expanded={open}
          onClick={onToggle}
        >
          {open ? <CaretDown size={12} /> : <CaretRight size={12} />}
          {title}
          <span className="changes__count">{count}</span>
        </button>
        {/* An empty group has nothing to act on, open or closed. */}
        {count > 0 && action}
      </h3>
      {open && count > 0 && children}
    </div>
  );
}

/** The whole-group button — stage, unstage or discard everything in one
 *  call. `danger` colours the one that destroys work. */
function SectionAction({
  label,
  Icon,
  disabled,
  danger,
  onClick,
}: {
  label: string;
  Icon: Icon;
  disabled: boolean;
  danger?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      className={`changes__title-action ${danger ? "changes__title-action--danger" : ""}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={14} />
    </button>
  );
}

interface ListProps {
  files: readonly GitChange[];
  ActionIcon: Icon;
  actionTitle: string;
  /** Offered only where discarding means something: the unstaged list.
   *  A staged change is not lost by discarding, so the staged list does
   *  not carry it. */
  onDiscard?: (path: string) => void;
  disabled: boolean;
  onAction: (path: string) => void;
  onOpenFile: (path: string) => void;
  onShowDiff: (file: GitChange) => void;
}

/** "3 changes" / "1 change" — the agent-edits row's tooltip counts them. */
function editCount(count: number): string {
  return `${String(count)} ${count === 1 ? "change" : "changes"}`;
}

function ChangeList({
  files,
  ActionIcon,
  actionTitle,
  disabled,
  onAction,
  onDiscard,
  onOpenFile,
  onShowDiff,
}: ListProps) {
  return (
    <ul className="changes__list">
      {files.map((file) => {
        // A file git no longer has can be neither opened nor diffed
        // against the working tree.
        const onDisk = file.label !== "deleted";
        return (
          <li key={file.path} className="changes__item" title={file.path}>
            <span className={`changes__badge changes__badge--${file.label}`}>
              {file.label[0].toUpperCase()}
            </span>
            <button
              type="button"
              className="changes__file"
              title={`Show the diff for ${file.path}`}
              onClick={() => onShowDiff(file)}
            >
              <span className="changes__filename">{fileName(file.path)}</span>
              {parentDir(file.path) && (
                <span className="changes__dir">{parentDir(file.path)}</span>
              )}
            </button>
            <FileMenu
              label={`Actions for ${file.path}`}
              items={[
                {
                  label: "Show diff",
                  icon: <GitDiff size={14} />,
                  onSelect: () => onShowDiff(file),
                },
                ...(onDisk
                  ? [
                      {
                        label: "Open in editor",
                        icon: <ArrowSquareOut size={14} />,
                        onSelect: () => onOpenFile(file.path),
                      },
                    ]
                  : []),
                {
                  label: actionTitle,
                  icon: <ActionIcon size={14} />,
                  disabled,
                  onSelect: () => onAction(file.path),
                },
                ...(onDiscard
                  ? [
                      {
                        label: "Discard changes",
                        icon: <Trash size={14} />,
                        disabled,
                        danger: true,
                        onSelect: () => onDiscard(file.path),
                      },
                    ]
                  : []),
              ]}
            />
          </li>
        );
      })}
    </ul>
  );
}

interface FileMenuItem {
  label: string;
  icon: ReactNode;
  disabled?: boolean;
  /** Destructive: coloured apart so it is not picked by muscle memory. */
  danger?: boolean;
  onSelect: () => void;
}

/**
 * UI — the kebab menu on a changed-file row. The actions used to be
 * inline icon buttons, but three of them ate the row's width and long
 * file names were cut off; one trigger keeps the name whole.
 */
function FileMenu({ label, items }: { label: string; items: FileMenuItem[] }) {
  const [open, setOpen] = useState(false);
  // The sidebar scrolls, so a menu on the bottom-most rows would be
  // clipped opening downward — flip it up when the room below is short.
  const [placement, setPlacement] = useState<"bottom" | "top">("bottom");
  const rootRef = useRef<HTMLDivElement>(null);

  const toggle = () => {
    if (!open) {
      const rect = rootRef.current?.getBoundingClientRect();
      setPlacement(rect && window.innerHeight - rect.bottom < 140 ? "top" : "bottom");
    }
    setOpen(!open);
  };

  // A click anywhere else closes the panel (the OptionPicker's pattern).
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [open]);

  return (
    <div className={`file-menu ${open ? "file-menu--open" : ""}`} ref={rootRef}>
      <button
        type="button"
        className="changes__file-action"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        onClick={toggle}
        onKeyDown={(e) => {
          if (e.key === "Escape") setOpen(false);
        }}
      >
        <DotsThree size={16} weight="bold" />
      </button>
      {open && (
        <div
          className={`file-menu__panel file-menu__panel--${placement}`}
          role="menu"
          aria-label={label}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
          }}
        >
          {items.map((item) => (
            <button
              key={item.label}
              type="button"
              role="menuitem"
              className={`file-menu__option ${
                item.danger ? "file-menu__option--danger" : ""
              }`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false);
                item.onSelect();
              }}
            >
              <span className="file-menu__icon">{item.icon}</span>
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
