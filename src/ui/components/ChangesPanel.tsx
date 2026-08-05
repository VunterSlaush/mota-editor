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
  DotsThree,
  GitBranch,
  GitDiff,
  Minus,
  Plus,
} from "@phosphor-icons/react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import { commitUrl } from "../../core/entities/gitRemote";
import type { AgentEditedFile } from "../../core/entities/tool";
import type { GitChange } from "../../core/ports/gitPort";
import type { GitActionResult } from "../../core/usecases/gitActions";
import type { GitChanges } from "../../core/usecases/loadGitChanges";
import { openExternalLink } from "../externalLink";
import { fileName } from "../fileName";
import type { AgentDiff } from "./ToolCallContentView";

interface Props {
  changes: GitChanges | null;
  busy: boolean;
  /** Files the agent itself reported editing this session (first-hand,
   *  unlike the git sections below). */
  agentEdits: readonly AgentEditedFile[];
  onStage: (path: string) => Promise<GitActionResult>;
  onUnstage: (path: string) => Promise<GitActionResult>;
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
  /** Show an agent-reported diff (full old/new text) in the modal. */
  onShowAgentDiff: (diff: AgentDiff) => void;
}

/** Which sections start open — all of them; collapsing is the exception. */
const ALL_OPEN = { agent: true, staged: true, unstaged: true, commits: true };

/**
 * UI — the project's source control, VS-style: fetch/pull/push, staged
 * and not-staged files with one-click (un)stage, and the recent commits.
 * Every section collapses, because a repo mid-refactor can list more
 * files than the sidebar is tall.
 */
export function ChangesPanel({
  changes,
  busy,
  agentEdits,
  onStage,
  onUnstage,
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
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<GitActionResult | null>(null);
  const [commitMessage, setCommitMessage] = useState("");
  const [open, setOpen] = useState(ALL_OPEN);

  const toggle = (section: keyof typeof ALL_OPEN) =>
    setOpen((current) => ({ ...current, [section]: !current[section] }));

  const run = async (
    action: () => Promise<GitActionResult>,
  ): Promise<GitActionResult> => {
    setWorking(true);
    setNotice(null);
    const result = await action();
    setNotice(result.message ? result : null);
    setWorking(false);
    onRefresh();
    return result;
  };

  // Opening a file changes nothing in the repo, so it neither disables
  // the panel nor triggers a refresh — but a failure must still be said.
  const openFile = async (path: string) => {
    const error = await onOpenFile(path);
    setNotice(error ? { ok: false, message: error } : null);
  };

  // Reading git is safe while the agent works; moving the index under it
  // is not. Only the refresh stays live.
  const mutationsDisabled = busy || working;
  const currentBranch = changes?.branches.find((b) => b.current)?.name ?? "";
  const canCommit =
    !mutationsDisabled &&
    (changes?.staged.length ?? 0) > 0 &&
    commitMessage.trim() !== "";

  const commitPush = async () => {
    const result = await run(() => onCommitPush(commitMessage));
    if (result.ok) setCommitMessage("");
  };

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
          disabled={working}
          title="Fetch and prune remote-tracking branches"
          onClick={() => void run(onFetch)}
        >
          <ArrowsClockwise /> Fetch
        </button>
        <button
          type="button"
          className="changes__action"
          disabled={mutationsDisabled}
          onClick={() => void run(onPull)}
        >
          <ArrowLineDown /> Pull
        </button>
        <button
          type="button"
          className="changes__action"
          disabled={mutationsDisabled}
          onClick={() => void run(onPush)}
        >
          <ArrowLineUp /> Push
        </button>
        <button
          type="button"
          className="changes__action changes__action--icon"
          disabled={working}
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
          <Check /> Commit & Push
        </button>
      </div>

      {notice && (
        <p className={`changes__notice ${notice.ok ? "" : "changes__notice--error"}`}>
          {notice.message}
        </p>
      )}

      {agentEdits.length > 0 && (
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
                    file.diff
                      ? `Show the agent's change to ${file.path}`
                      : `Open ${file.path}`
                  }
                  onClick={() =>
                    file.diff
                      ? onShowAgentDiff({ path: file.path, ...file.diff })
                      : void onOpenFile(file.path)
                  }
                >
                  <span className="changes__filename">{fileName(file.path)}</span>
                  {parentDir(file.path) && (
                    <span className="changes__dir">{parentDir(file.path)}</span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {!changes ? (
        <p className="changes__empty">Not a git repository (or git isn't installed).</p>
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
          >
            <ChangeList
              files={changes.unstaged}
              ActionIcon={Plus}
              actionTitle="Stage"
              disabled={mutationsDisabled}
              onAction={(path) => void run(() => onStage(path))}
              onOpenFile={(path) => void openFile(path)}
              onShowDiff={(file) => onShowDiff(file, false)}
            />
          </Section>
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
    </aside>
  );
}

/** A titled, collapsible group with its item count in the header. */
function Section({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  title: string;
  count: number;
  open: boolean;
  onToggle: () => void;
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
      </h3>
      {open && count > 0 && children}
    </div>
  );
}

interface ListProps {
  files: readonly GitChange[];
  ActionIcon: Icon;
  actionTitle: string;
  disabled: boolean;
  onAction: (path: string) => void;
  onOpenFile: (path: string) => void;
  onShowDiff: (file: GitChange) => void;
}

/** The path without its file name — the gray VS-style suffix. */
function parentDir(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : "";
}

function ChangeList({
  files,
  ActionIcon,
  actionTitle,
  disabled,
  onAction,
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
              className="file-menu__option"
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
