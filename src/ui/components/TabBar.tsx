import { FolderSimple, GitFork } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import { tabLabel } from "../../core/entities/project";
import type { TabColorId } from "../../core/entities/tabColor";
import { TAB_STATUS_LABELS, tabStatus } from "../../core/entities/tabStatus";
import type { TabState } from "../../core/state/appState";
import { useDragReorder } from "../useDragReorder";
import { TabMenu } from "./TabMenu";
import { tabDensity } from "./tabDensity";

interface Props {
  tabs: readonly TabState[];
  activeTabId: string | null;
  onSelect: (tabId: string) => void;
  onClose: (tabId: string) => void;
  onReorder: (tabId: string, toIndex: number) => void;
  onOpenProject: () => void;
  onRename: (tabId: string, label: string) => void;
  onRecolor: (tabId: string, color: TabColorId | undefined) => void;
}

/** UI — one tab per project, plus the "open project" affordance. */
export function TabBar({
  tabs,
  activeTabId,
  onSelect,
  onClose,
  onReorder,
  onOpenProject,
  onRename,
  onRecolor,
}: Props) {
  const drag = useDragReorder(onReorder, ".tab");
  const strip = useRef<HTMLElement>(null);
  const density = tabDensity(useWidthOf(strip), tabs.length);
  const [menu, setMenu] = useState<{ tabId: string; anchor: DOMRect } | null>(null);
  // Undefined once the tab is gone, so closing a tab with its menu open
  // takes the menu with it.
  const menuTab = menu ? tabs.find((t) => t.project.id === menu.tabId) : undefined;

  return (
    // The header itself drags the window; the tabs on it drag each other.
    <header className={`tab-bar tab-bar--${density}`} data-tauri-drag-region ref={strip}>
      {tabs.map((tab) => {
        const id = tab.project.id;
        const isActive = id === activeTabId;
        const status = tabStatus(tab);
        const statusLabel = TAB_STATUS_LABELS[status];
        // The branch comes from the tab's cached git read, never a live call.
        const at = tab.branch ? `${tab.project.path} (${tab.branch})` : tab.project.path;
        const where = tab.project.worktreeOf
          ? `${at} — worktree of ${tab.project.worktreeOf}`
          : at;
        const name = tabLabel(tab.project);
        // A named tab still has to say where it points: the name took the
        // folder's place in the strip, so the tooltip is where that goes.
        const named = tab.project.label ? `${tab.project.label} — ${where}` : where;
        return (
          <div
            key={id}
            className={`tab ${isActive ? "tab--active" : ""} tab--${status} ${
              drag.draggingId === id ? "tab--dragging" : ""
            }`}
            title={statusLabel ? `${named} — ${statusLabel}` : named}
            data-color={tab.project.color}
            onPointerDown={(e) => drag.startDrag(id, e)}
            // The click that ends a drop is the drop, not a tab switch.
            onClick={() => {
              if (!drag.wasDragged()) onSelect(id);
            }}
            // preventDefault, or the webview draws its own menu on top.
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ tabId: id, anchor: e.currentTarget.getBoundingClientRect() });
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
                aria-label={statusLabel}
              />
            )}
            <span className="tab__name">{name}</span>
            {/* Which checkout this is. With worktrees two tabs of one
                repository differ by nothing else, so it earns its width
                — and gives it back first when the strip runs short. */}
            {tab.branch && <span className="tab__branch">{tab.branch}</span>}
            <button
              type="button"
              className="tab__close"
              aria-label={`Close ${name}`}
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
      {menuTab && menu && (
        <TabMenu
          anchor={menu.anchor}
          label={menuTab.project.label ?? ""}
          color={menuTab.project.color}
          folderName={menuTab.project.name}
          onRename={(label) => onRename(menuTab.project.id, label)}
          onRecolor={(color) => onRecolor(menuTab.project.id, color)}
          onClose={() => setMenu(null)}
        />
      )}
    </header>
  );
}

/**
 * The element's width, kept current as the window resizes. Zero until
 * the first measurement, which `tabDensity` reads as "not known yet".
 */
function useWidthOf(element: React.RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const node = element.current;
    if (!node) return;
    const observer = new ResizeObserver(([entry]) => {
      setWidth(entry.contentRect.width);
    });
    observer.observe(node);
    return () => observer.disconnect();
  }, [element]);

  return width;
}
