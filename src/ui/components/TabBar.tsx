import { FolderSimple, GitFork } from "@phosphor-icons/react";
import { TAB_STATUS_LABELS, tabStatus } from "../../core/entities/tabStatus";
import type { TabState } from "../../core/state/appState";
import { useDragReorder } from "../useDragReorder";

interface Props {
  tabs: readonly TabState[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (tabId: string, toIndex: number) => void;
  onOpenProject: () => void;
}

/** UI — one tab per project, plus the "open project" affordance. */
export function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onReorder,
  onOpenProject,
}: Props) {
  const drag = useDragReorder(onReorder, ".tab");

  return (
    // The header itself drags the window; the tabs on it drag each other.
    <header className="tab-bar" data-tauri-drag-region>
      {tabs.map((tab) => {
        const id = tab.project.id;
        const isActive = id === activeTabId;
        const status = tabStatus(tab);
        const label = TAB_STATUS_LABELS[status];
        // The branch comes from the tab's cached git read, never a live call.
        const at = tab.branch ? `${tab.project.path} (${tab.branch})` : tab.project.path;
        const where = tab.project.worktreeOf
          ? `${at} — worktree of ${tab.project.worktreeOf}`
          : at;
        return (
          <div
            key={id}
            className={`tab ${isActive ? "tab--active" : ""} tab--${status} ${
              drag.draggingId === id ? "tab--dragging" : ""
            }`}
            title={label ? `${where} — ${label}` : where}
            onPointerDown={(e) => drag.startDrag(id, e)}
            // The click that ends a drop is the drop, not a tab switch.
            onClick={() => {
              if (!drag.wasDragged()) onSelect(id);
            }}
          >
            {/* Folder vs worktree at a glance; the tooltip says which repo. */}
            <span className="tab__icon">
              {tab.project.worktreeOf ? (
                <GitFork size={13} aria-hidden="true" />
              ) : (
                <FolderSimple size={13} aria-hidden="true" />
              )}
            </span>
            {status !== "idle" && (
              <span
                className={`tab__dot tab__dot--${status}`}
                role="img"
                aria-label={label}
              />
            )}
            <span className="tab__name">{tab.project.name}</span>
            <button
              type="button"
              className="tab__close"
              aria-label={`Close ${tab.project.name}`}
              onClick={(e) => {
                e.stopPropagation();
                onClose(id);
              }}
            >
              ×
            </button>
          </div>
        );
      })}
      <button
        type="button"
        className="tab-bar__add"
        onClick={onOpenProject}
        title="Open a project folder"
      >
        +
      </button>
    </header>
  );
}
