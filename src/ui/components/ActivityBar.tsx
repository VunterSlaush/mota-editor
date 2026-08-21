import type { Icon } from "@phosphor-icons/react";
import {
  Bug,
  Calendar,
  ClockCounterClockwise,
  Files,
  Gear,
  GitBranch,
  GitFork,
  Kanban,
  ListChecks,
  PuzzlePiece,
  Rocket,
  TreeStructure,
} from "@phosphor-icons/react";
import type { ExtensionPanelRef } from "../../core/entities/extension";

export type SidebarView =
  | "files"
  | "changes"
  | "history"
  | "worktrees"
  | "subtasks"
  | `ext:${string}`;

/** The sidebar-view id an extension panel occupies. */
export function panelSidebarView(panel: ExtensionPanelRef): SidebarView {
  return `ext:${panel.extensionId}:${panel.panelId}`;
}

interface Props {
  active: SidebarView | null;
  /** The builtin views this tab offers — not every tab has every one. */
  available: readonly SidebarView[];
  /** Panels contributed by active extensions — one icon each. */
  panels: readonly ExtensionPanelRef[];
  onSelect: (view: SidebarView | null) => void;
  onOpenSettings: () => void;
}

const ITEMS: readonly { view: SidebarView; Icon: Icon; title: string }[] = [
  { view: "files", Icon: Files, title: "Files" },
  { view: "changes", Icon: GitBranch, title: "Source control" },
  { view: "history", Icon: ClockCounterClockwise, title: "Session history" },
  { view: "worktrees", Icon: GitFork, title: "Worktrees" },
  { view: "subtasks", Icon: TreeStructure, title: "Subtasks" },
];

/** Every builtin view, for the tabs that offer all of them. */
export const ALL_SIDEBAR_VIEWS: readonly SidebarView[] = ITEMS.map((item) => item.view);

/** Manifests name an icon from this closed set — extensions cannot draw
 *  arbitrary pixels in the activity bar (ADR-0013). */
const PANEL_ICONS: Readonly<Record<string, Icon>> = {
  checklist: ListChecks,
  kanban: Kanban,
  bug: Bug,
  calendar: Calendar,
  rocket: Rocket,
};

/**
 * UI — VS-style activity bar: icons that switch (or collapse) the
 * sidebar — the builtin views this tab offers, then one per extension
 * panel — and the gear, which opens settings as a modal rather than a
 * sidebar view.
 */
export function ActivityBar({
  active,
  available,
  panels,
  onSelect,
  onOpenSettings,
}: Props) {
  const viewButton = (view: SidebarView, ItemIcon: Icon, title: string) => (
    <button
      type="button"
      key={view}
      className={`activity-bar__item ${
        active === view ? "activity-bar__item--active" : ""
      }`}
      title={title}
      aria-label={title}
      onClick={() => onSelect(active === view ? null : view)}
    >
      <ItemIcon size={20} weight={active === view ? "fill" : "regular"} />
    </button>
  );

  return (
    <nav className="activity-bar" aria-label="Sidebar views">
      {ITEMS.filter((item) => available.includes(item.view)).map((item) =>
        viewButton(item.view, item.Icon, item.title),
      )}
      {panels.map((panel) =>
        viewButton(
          panelSidebarView(panel),
          PANEL_ICONS[panel.icon ?? ""] ?? PuzzlePiece,
          panel.title,
        ),
      )}
      <button
        type="button"
        className="activity-bar__item"
        title="Settings"
        aria-label="Settings"
        onClick={onOpenSettings}
      >
        <Gear size={20} />
      </button>
    </nav>
  );
}
