import type { Icon } from "@phosphor-icons/react";
import {
  Bug,
  Calendar,
  ClockCounterClockwise,
  Coins,
  Files,
  Funnel,
  Gear,
  GitBranch,
  GitFork,
  Kanban,
  Lightning,
  ListChecks,
  PuzzlePiece,
  Rocket,
  TreeStructure,
} from "@phosphor-icons/react";
import type { ReactNode } from "react";
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

/** Manifests name an icon from this closed set, or ship an image file
 *  (ADR-0021) that the host draws as a silhouette in the bar's own
 *  colours — see `panelIcon`. */
const PANEL_ICONS: Readonly<Record<string, Icon>> = {
  checklist: ListChecks,
  kanban: Kanban,
  bug: Bug,
  calendar: Calendar,
  rocket: Rocket,
  coins: Coins,
  funnel: Funnel,
  lightning: Lightning,
};

/** An extension's own icon file, drawn like the built-in glyphs: the
 *  image is a CSS mask filled with `currentColor`, so it dims, lights on
 *  hover, and takes the accent when active exactly as its neighbours do.
 *  The cost is that a coloured logo becomes its silhouette — the same
 *  trade VS Code makes in its activity bar. */
function panelIcon(dataUrl: string): ReactNode {
  const mask = `url("${dataUrl}")`;
  return (
    <span
      className="activity-bar__image"
      style={{ maskImage: mask, WebkitMaskImage: mask }}
      aria-hidden="true"
    />
  );
}

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
  const viewButton = (view: SidebarView, ItemIcon: Icon, title: string) =>
    viewButtonWith(
      view,
      title,
      <ItemIcon size={20} weight={active === view ? "fill" : "regular"} />,
    );

  const viewButtonWith = (view: SidebarView, title: string, icon: ReactNode) => (
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
      {icon}
    </button>
  );

  return (
    <nav className="activity-bar" aria-label="Sidebar views">
      {ITEMS.filter((item) => available.includes(item.view)).map((item) =>
        viewButton(item.view, item.Icon, item.title),
      )}
      {panels.map((panel) =>
        panel.iconData
          ? viewButtonWith(
              panelSidebarView(panel),
              panel.title,
              panelIcon(panel.iconData),
            )
          : viewButton(
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
