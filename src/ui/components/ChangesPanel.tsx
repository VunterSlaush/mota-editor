import { useState } from "react";
import type { Icon } from "@phosphor-icons/react";
import {
  ArrowClockwise,
  ArrowLineDown,
  ArrowLineUp,
  CaretDown,
  Check,
  GitBranch,
  Minus,
  Plus,
} from "@phosphor-icons/react";
import type { GitChanges } from "../../core/usecases/loadGitChanges";
import type { GitActionResult } from "../../core/usecases/gitActions";
import type { GitChange } from "../../core/ports/gitPort";
import { fileName } from "../fileName";

interface Props {
  changes: GitChanges | null;
  busy: boolean;
  onStage: (path: string) => Promise<GitActionResult>;
  onUnstage: (path: string) => Promise<GitActionResult>;
  onCommitPush: (message: string) => Promise<GitActionResult>;
  onOpenBranchPicker: () => void;
  onPush: () => Promise<GitActionResult>;
  onPull: () => Promise<GitActionResult>;
  onRefresh: () => void;
}

/**
 * UI — the project's source control, VS-style: pull/push, staged and
 * not-staged files with one-click (un)stage, and the last commits.
 */
export function ChangesPanel({
  changes,
  busy,
  onStage,
  onUnstage,
  onCommitPush,
  onOpenBranchPicker,
  onPush,
  onPull,
  onRefresh,
}: Props) {
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState<GitActionResult | null>(null);
  const [commitMessage, setCommitMessage] = useState("");

  const run = async (action: () => Promise<GitActionResult>): Promise<GitActionResult> => {
    setWorking(true);
    setNotice(null);
    const result = await action();
    setNotice(result.message ? result : null);
    setWorking(false);
    onRefresh();
    return result;
  };

  const disabled = busy || working;
  const currentBranch = changes?.branches.find((b) => b.current)?.name ?? "";
  const canCommit =
    !disabled && (changes?.staged.length ?? 0) > 0 && commitMessage.trim() !== "";

  const commitPush = async () => {
    const result = await run(() => onCommitPush(commitMessage));
    if (result.ok) setCommitMessage("");
  };

  return (
    <aside className="changes">
      {changes && changes.branches.length > 0 && (
        <button
          className="changes__branch"
          disabled={disabled}
          title="Checkout a branch"
          onClick={onOpenBranchPicker}
        >
          <GitBranch />
          {currentBranch}
          <CaretDown className="changes__branch-chevron" />
        </button>
      )}
      <div className="changes__actions">
        <button className="changes__action" disabled={disabled} onClick={() => void run(onPull)}>
          <ArrowLineDown /> Pull
        </button>
        <button className="changes__action" disabled={disabled} onClick={() => void run(onPush)}>
          <ArrowLineUp /> Push
        </button>
        <button
          className="changes__action changes__action--icon"
          disabled={disabled}
          title="Refresh"
          onClick={onRefresh}
        >
          <ArrowClockwise />
        </button>
      </div>

      <div className="changes__commit">
        <input
          className="changes__commit-message"
          value={commitMessage}
          placeholder="Commit message"
          disabled={disabled}
          onChange={(e) => setCommitMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && canCommit) void commitPush();
          }}
        />
        <button
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

      {!changes ? (
        <p className="changes__empty">Not a git repository (or git isn't installed).</p>
      ) : (
        <>
          {changes.staged.length === 0 && changes.unstaged.length === 0 && (
            <p className="changes__empty">Working tree clean.</p>
          )}
          <ChangeGroup
            title={`Staged (${changes.staged.length})`}
            files={changes.staged}
            ActionIcon={Minus}
            actionTitle="Unstage"
            disabled={disabled}
            onAction={(path) => void run(() => onUnstage(path))}
          />
          <ChangeGroup
            title={`Not staged (${changes.unstaged.length})`}
            files={changes.unstaged}
            ActionIcon={Plus}
            actionTitle="Stage"
            disabled={disabled}
            onAction={(path) => void run(() => onStage(path))}
          />
          {changes.commits.length > 0 && (
            <div className="changes__group">
              <h3 className="changes__title">Last commits</h3>
              <ul className="changes__list">
                {changes.commits.map((commit) => (
                  <li key={commit.hash} className="commit" title={`${commit.author} — ${commit.when}`}>
                    <span className="commit__hash">{commit.hash}</span>
                    <span className="commit__subject">{commit.subject}</span>
                    <span className="commit__when">{commit.when}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

interface GroupProps {
  title: string;
  files: readonly GitChange[];
  ActionIcon: Icon;
  actionTitle: string;
  disabled: boolean;
  onAction: (path: string) => void;
}

/** The path without its file name — the gray VS-style suffix. */
function parentDir(path: string): string {
  const cut = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return cut > 0 ? path.slice(0, cut) : "";
}

function ChangeGroup({ title, files, ActionIcon, actionTitle, disabled, onAction }: GroupProps) {
  if (files.length === 0) return null;
  return (
    <div className="changes__group">
      <h3 className="changes__title">{title}</h3>
      <ul className="changes__list">
        {files.map((file) => (
          <li key={file.path} className="changes__item" title={file.path}>
            <span className={`changes__badge changes__badge--${file.label}`}>
              {file.label[0].toUpperCase()}
            </span>
            <span className="changes__file">
              <span className="changes__filename">{fileName(file.path)}</span>
              {parentDir(file.path) && (
                <span className="changes__dir">{parentDir(file.path)}</span>
              )}
            </span>
            <button
              className="changes__file-action"
              title={`${actionTitle} ${file.path}`}
              disabled={disabled}
              onClick={() => onAction(file.path)}
            >
              <ActionIcon size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
