import { PencilSimple, Plus, TreeStructure } from "@phosphor-icons/react";
import { tabLabel } from "../../core/entities/project";
import { describeScope } from "../../core/entities/subtask";
import { TAB_STATUS_LABELS, tabStatus } from "../../core/entities/tabStatus";
import { samePath } from "../../core/entities/worktree";
import type { TabState } from "../../core/state/appState";

interface Props {
  /** Every open tab — the rows and their live status come from here. */
  tabs: readonly TabState[];
  /** The tab the panel is shown from. */
  currentTab: TabState;
  onActivate: (tabId: string) => void;
  /** Opens the picker, which owns creating a subtask. */
  onNewSubtask: () => void;
  /** Opens the picker on the current tab's own scope. */
  onEditScope: () => void;
}

/**
 * UI — the subtask tabs working this tab's folder. A subtask exists only
 * as a tab (plus its workspace entry), so unlike the worktrees panel
 * there is nothing to list from disk: closed means gone, and every row
 * here can simply be activated.
 *
 * Shown on every tab, including subtasks themselves — a subtask tab is
 * exactly where its own scope is read and edited.
 */
export function SubtasksPanel({
  tabs,
  currentTab,
  onActivate,
  onNewSubtask,
  onEditScope,
}: Props) {
  const ownScope = currentTab.project.subtask;
  const rows = tabs.filter(
    (t) => t.project.subtask && samePath(t.project.path, currentTab.project.path),
  );

  return (
    <aside className="worktrees">
      <div className="changes__actions">
        <button
          type="button"
          className="changes__action"
          title="Open a scoped tab on this folder"
          onClick={onNewSubtask}
        >
          <Plus /> New subtask
        </button>
      </div>

      {ownScope && (
        <div className="changes__item worktrees__item" title="This tab's own scope">
          <span className="worktrees__icon">
            <TreeStructure size={13} />
          </span>
          <span className="changes__file">
            <span className="changes__filename">This tab</span>
            <span className="changes__dir">{describeScope(ownScope)}</span>
          </span>
          <button
            type="button"
            className="worktree-picker__remove worktrees__remove"
            aria-label="Edit this subtask's scope"
            title="Edit scope — the agent session restarts with the new one"
            onClick={onEditScope}
          >
            <PencilSimple size={13} aria-hidden="true" />
          </button>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="changes__list">
          {rows.map((row) => (
            <li key={row.project.id}>
              <SubtaskRow
                row={row}
                current={row.project.id === currentTab.project.id}
                onActivate={() => onActivate(row.project.id)}
              />
            </li>
          ))}
        </ul>
      )}
      {rows.length === 0 && (
        <p className="changes__empty">
          No subtasks yet — New subtask opens another tab on this folder whose agent is
          read-only or confined to folders you pick.
        </p>
      )}
    </aside>
  );
}

/** One subtask tab: its name, its authority, and what it is doing. */
function SubtaskRow({
  row,
  current,
  onActivate,
}: {
  row: TabState;
  current: boolean;
  onActivate: () => void;
}) {
  const status = tabStatus(row);
  return (
    <div className="changes__item worktrees__item" title={row.project.path}>
      <span className="worktrees__icon">
        <TreeStructure size={13} />
      </span>
      <button
        type="button"
        className="changes__file"
        title={current ? "This tab" : "Go to this tab"}
        onClick={onActivate}
      >
        <span className="changes__filename">{tabLabel(row.project)}</span>
        <span className="changes__dir">
          {row.project.subtask ? describeScope(row.project.subtask) : ""}
        </span>
      </button>
      {current && <span className="worktrees__badge">current</span>}
      {!current && status === "idle" && <span className="worktrees__badge">open</span>}
      {!current && status !== "idle" && (
        <span
          className={`tab__dot tab__dot--${status}`}
          role="img"
          aria-label={TAB_STATUS_LABELS[status]}
          title={TAB_STATUS_LABELS[status]}
        />
      )}
    </div>
  );
}
