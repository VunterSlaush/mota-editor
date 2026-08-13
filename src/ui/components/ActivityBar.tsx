import type { Icon } from "@phosphor-icons/react";
import { ClockCounterClockwise, Gear, GitBranch, GitFork } from "@phosphor-icons/react";

export type SidebarView = "changes" | "history" | "worktrees";

interface Props {
  active: SidebarView | null;
  /** The views this tab offers — not every tab has every one. */
  available: readonly SidebarView[];
  onSelect: (view: SidebarView | null) => void;
  onOpenSettings: () => void;
}

const ITEMS: readonly { view: SidebarView; Icon: Icon; title: string }[] = [
  { view: "changes", Icon: GitBranch, title: "Source control" },
  { view: "history", Icon: ClockCounterClockwise, title: "Session history" },
  { view: "worktrees", Icon: GitFork, title: "Worktrees" },
];

/** Every view, for the tabs that offer all of them. */
export const ALL_SIDEBAR_VIEWS: readonly SidebarView[] = ITEMS.map((item) => item.view);

/**
 * UI — VS-style activity bar: icons that switch (or collapse) the
 * sidebar, and the gear, which opens settings as a modal rather than a
 * sidebar view — settings now span more than a narrow column.
 */
export function ActivityBar({ active, available, onSelect, onOpenSettings }: Props) {
  return (
    <nav className="activity-bar" aria-label="Sidebar views">
      {ITEMS.filter((item) => available.includes(item.view)).map((item) => (
        <button
          type="button"
          key={item.view}
          className={`activity-bar__item ${
            active === item.view ? "activity-bar__item--active" : ""
          }`}
          title={item.title}
          aria-label={item.title}
          onClick={() => onSelect(active === item.view ? null : item.view)}
        >
          <item.Icon size={20} weight={active === item.view ? "fill" : "regular"} />
        </button>
      ))}
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
