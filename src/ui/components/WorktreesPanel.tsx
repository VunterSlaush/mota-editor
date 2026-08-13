import { ArrowClockwise, FolderSimple, GitFork, Plus } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { TAB_STATUS_LABELS } from "../../core/entities/tabStatus";
import type { TabState } from "../../core/state/appState";
import type { HistoryItem } from "../../core/usecases/history";
import type { WorktreeRow } from "../../core/usecases/worktreeOverview";
import { worktreeOverview } from "../../core/usecases/worktreeOverview";
import type { WorktreeItem } from "../../core/usecases/worktrees";

/** How many worktree sessions the panel lists before saying "see all". */
const SESSION_LIMIT = 6;

interface Props {
  /** The repository's checkouts. Asked once per refresh, not per render. */
  loadWorktrees: () => Promise<readonly WorktreeItem[]>;
  /** Conversations had in those checkouts, newest first. */
  loadWorktreeSessions: () => Promise<readonly HistoryItem[]>;
  /** Every open tab — a row's live status is read from here, not git. */
  tabs: readonly TabState[];
  /** The checkout the panel is shown from; its row reads "current". */
  currentPath: string;
  onOpen: (path: string, mainPath: string) => void;
  /** Opens the picker, which owns creating and removing a worktree. */
  onNewWorktree: () => void;
  /** Loads a session into its own worktree's tab, opening it if closed. */
  onOpenSession: (item: HistoryItem) => void;
  /** Takes the user to the full history, where the rest of them are. */
  onShowAllSessions: () => void;
}

/**
 * UI — the repository's worktrees, and what each one's agent is doing.
 * Shown on a main checkout only: a worktree tab has no siblings to
 * offer, and the question this answers ("what is running where?") is one
 * you ask from the root folder.
 *
 * Clicking a row goes to its tab, or opens one when the worktree was
 * closed — which is the whole point, since closing a worktree tab leaves
 * the worktree itself on disk (ADR-0007).
 *
 * Making and deleting one stays in the picker this panel's button opens:
 * that needs a bounded branch search and a two-step confirm, neither of
 * which survives being rebuilt in a column that drags down to 180px.
 */
export function WorktreesPanel({
  loadWorktrees,
  loadWorktreeSessions,
  tabs,
  currentPath,
  onOpen,
  onNewWorktree,
  onOpenSession,
  onShowAllSessions,
}: Props) {
  const [worktrees, setWorktrees] = useState<readonly WorktreeItem[] | null>(null);
  const [sessions, setSessions] = useState<readonly HistoryItem[]>([]);
  const [refreshKey, setRefreshKey] = useState(0);

  // The listing changes when a worktree is created or removed, and both
  // of those open or close a tab — so the set of tab ids is the signal,
  // and nothing here needs a timer. A turn starting or ending moves no
  // worktree, and the status it changes is read from `tabs` live.
  const tabIds = tabs.map((tab) => tab.project.id).join(" ");
  useEffect(() => {
    let cancelled = false;
    loadWorktrees().then((loaded) => {
      if (!cancelled) setWorktrees(loaded);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, tabIds, refreshKey]);

  // The sessions follow the same signal, plus every finished turn: a
  // conversation in another checkout is saved when its turn ends, and
  // this list is the only place the main checkout would see it appear.
  const idleTabs = tabs.filter((tab) => !tab.busy).length;
  useEffect(() => {
    let cancelled = false;
    loadWorktreeSessions().then((loaded) => {
      if (!cancelled) setSessions(loaded);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPath, tabIds, idleTabs, refreshKey]);

  const rows = useMemo(
    () => worktreeOverview(worktrees ?? [], tabs, currentPath),
    [worktrees, tabs, currentPath],
  );
  const mainPath = rows.find((row) => row.main)?.path ?? currentPath;
  const linked = rows.filter((row) => !row.main);

  return (
    <aside className="worktrees">
      <div className="changes__actions">
        {rows.length > 0 && (
          <button
            type="button"
            className="changes__action"
            title="Open or create a worktree"
            onClick={onNewWorktree}
          >
            <Plus /> New worktree
          </button>
        )}
        <button
          type="button"
          className="changes__action changes__action--icon"
          aria-label="Refresh the worktree list"
          title="Refresh"
          onClick={() => setRefreshKey((key) => key + 1)}
        >
          <ArrowClockwise />
        </button>
      </div>

      {worktrees === null && <p className="changes__empty">Loading worktrees…</p>}
      {worktrees !== null && rows.length === 0 && (
        <p className="changes__empty">Not a git repository (or git isn't installed).</p>
      )}
      {rows.length > 0 && (
        <ul className="changes__list">
          {rows.map((row) => (
            <WorktreeRowItem
              key={row.path}
              row={row}
              onOpen={() => onOpen(row.path, mainPath)}
            />
          ))}
        </ul>
      )}
      {worktrees !== null && rows.length > 0 && linked.length === 0 && (
        <p className="changes__empty">
          No worktrees yet — New worktree makes one and opens it in its own tab.
        </p>
      )}
      {sessions.length > 0 && (
        <WorktreeSessions
          sessions={sessions}
          onOpen={onOpenSession}
          onShowAll={onShowAllSessions}
        />
      )}
    </aside>
  );
}

/**
 * The last conversations had in the worktrees, in brief: title and
 * where. The full list — search, scopes, this checkout's own sessions —
 * is Session history's job, and the last row goes there rather than
 * growing a second copy of it in a narrow column.
 */
function WorktreeSessions({
  sessions,
  onOpen,
  onShowAll,
}: {
  sessions: readonly HistoryItem[];
  onOpen: (item: HistoryItem) => void;
  onShowAll: () => void;
}) {
  return (
    <div className="worktrees__sessions">
      <h3 className="changes__title">Recent worktree sessions</h3>
      <ul className="changes__list">
        {sessions.slice(0, SESSION_LIMIT).map((session) => (
          <li key={session.id} className="worktrees__session">
            <button
              type="button"
              className="changes__file"
              title={`${session.from?.path ?? ""}\nOpens this session in that worktree's tab`}
              onClick={() => onOpen(session)}
            >
              <span className="changes__filename">{session.title}</span>
              <span className="changes__dir">{session.from?.label}</span>
            </button>
          </li>
        ))}
      </ul>
      {sessions.length > SESSION_LIMIT && (
        <button type="button" className="worktrees__more" onClick={onShowAll}>
          {sessions.length - SESSION_LIMIT} more in Session history
        </button>
      )}
    </div>
  );
}

/**
 * One checkout: what it is, and what its agent is up to. A row with no
 * tab open is the interesting one — it is the click that brings a closed
 * worktree back.
 */
function WorktreeRowItem({ row, onOpen }: { row: WorktreeRow; onOpen: () => void }) {
  const name = row.branch || `detached @ ${row.head.slice(0, 7)}`;
  return (
    <li className="changes__item worktrees__item" title={row.path}>
      <span className="worktrees__icon">
        {row.main ? <FolderSimple size={13} /> : <GitFork size={13} />}
      </span>
      <button
        type="button"
        className="changes__file"
        // A prunable worktree's folder is already gone: opening it would
        // make a tab whose agent cannot start in it.
        disabled={row.prunable}
        title={openTitle(row)}
        onClick={onOpen}
      >
        <span className="changes__filename">{name}</span>
        <span className="changes__dir">{row.path}</span>
      </button>
      <WorktreeState row={row} />
    </li>
  );
}

/** What clicking the row promises — or why it promises nothing. */
function openTitle(row: WorktreeRow): string {
  if (row.prunable) return `${row.path}\nThe folder is gone; git has yet to prune it.`;
  if (row.current) return `${row.path}\nThis tab`;
  if (row.openTabId) return `${row.path}\nGo to this tab`;
  return `${row.path}\nOpen as a tab`;
}

/**
 * The right-hand state: the tab bar's own dot for a worktree that is
 * open, and a plain word for one that is not — "closed" is a state
 * worth reading at a glance, since it is the one you click.
 */
function WorktreeState({ row }: { row: WorktreeRow }) {
  if (row.current) return <span className="worktrees__badge">current</span>;
  if (!row.openTabId) return <span className="worktrees__badge">closed</span>;
  if (row.status === "idle") return <span className="worktrees__badge">open</span>;
  return (
    <span
      className={`tab__dot tab__dot--${row.status}`}
      role="img"
      aria-label={TAB_STATUS_LABELS[row.status]}
      title={TAB_STATUS_LABELS[row.status]}
    />
  );
}
