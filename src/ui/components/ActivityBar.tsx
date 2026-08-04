import type { Icon } from "@phosphor-icons/react";
import { ClockCounterClockwise, Gear, GitBranch } from "@phosphor-icons/react";

export type SidebarView = "changes" | "history" | "settings";

interface Props {
  active: SidebarView | null;
  onSelect: (view: SidebarView | null) => void;
}

const ITEMS: readonly { view: SidebarView; Icon: Icon; title: string }[] = [
  { view: "changes", Icon: GitBranch, title: "Source control" },
  { view: "history", Icon: ClockCounterClockwise, title: "Session history" },
  { view: "settings", Icon: Gear, title: "Settings" },
];

/** UI — VS-style activity bar: icons that switch (or collapse) the sidebar. */
export function ActivityBar({ active, onSelect }: Props) {
  return (
    <nav className="activity-bar" aria-label="Sidebar views">
      {ITEMS.map((item) => (
        <button
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
    </nav>
  );
}
