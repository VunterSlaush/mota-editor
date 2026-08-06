import { TAB_STATUS_LABELS, tabStatus } from "../../core/entities/tabStatus";
import type { TabState } from "../../core/state/appState";

interface Props {
  tabs: readonly TabState[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onOpenProject: () => void;
}

/** UI — one tab per project, plus the "open project" affordance. */
export function TabBar({ tabs, activeTabId, onSelect, onClose, onOpenProject }: Props) {
  return (
    <header className="tab-bar" data-tauri-drag-region>
      {tabs.map((tab) => {
        const id = tab.project.id;
        const isActive = id === activeTabId;
        const status = tabStatus(tab);
        const label = TAB_STATUS_LABELS[status];
        // The branch comes from the tab's cached git read, never a live call.
        const where = tab.branch
          ? `${tab.project.path} (${tab.branch})`
          : tab.project.path;
        return (
          <div
            key={id}
            className={`tab ${isActive ? "tab--active" : ""} tab--${status}`}
            title={label ? `${where} — ${label}` : where}
            onClick={() => onSelect(id)}
          >
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
