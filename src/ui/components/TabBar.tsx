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
        return (
          <div
            key={id}
            className={`tab ${isActive ? "tab--active" : ""} ${
              tab.attention ? "tab--attention" : ""
            }`}
            title={tab.project.path}
            onClick={() => onSelect(id)}
          >
            {tab.busy && <span className="tab__spinner" aria-label="working" />}
            {!tab.busy && tab.attention && (
              <span className="tab__attention-dot" aria-label="finished — needs review" />
            )}
            <span className="tab__name">{tab.project.name}</span>
            <button
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
      <button className="tab-bar__add" onClick={onOpenProject} title="Open a project folder">
        +
      </button>
    </header>
  );
}
