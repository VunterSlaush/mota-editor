import type { Icon } from "@phosphor-icons/react";
import {
  Bug,
  Calendar,
  ClockCounterClockwise,
  Gear,
  GitBranch,
  Kanban,
  ListChecks,
  PuzzlePiece,
  Rocket,
} from "@phosphor-icons/react";
import type { ExtensionPanelRef } from "../../core/entities/extension";

export type SidebarView = "changes" | "history" | `ext:${string}`;

/** The sidebar-view id an extension panel occupies. */
export function panelSidebarView(panel: ExtensionPanelRef): SidebarView {
  return `ext:${panel.extensionId}:${panel.panelId}`;
}

interface Props {
  active: SidebarView | null;
  /** Panels contributed by active extensions — one icon each. */
  panels: readonly ExtensionPanelRef[];
  onSelect: (view: SidebarView | null) => void;
  onOpenSettings: () => void;
}

const ITEMS: readonly { view: SidebarView; Icon: Icon; title: string }[] = [
  { view: "changes", Icon: GitBranch, title: "Source control" },
  { view: "history", Icon: ClockCounterClockwise, title: "Session history" },
];

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
 * sidebar — the builtin views, then one per extension panel — and the
 * gear, which opens settings as a modal rather than a sidebar view.
 */
export function ActivityBar({ active, panels, onSelect, onOpenSettings }: Props) {
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
      {ITEMS.map((item) => viewButton(item.view, item.Icon, item.title))}
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
