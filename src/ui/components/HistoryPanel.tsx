import { ArrowsClockwise, GitFork, MagnifyingGlass } from "@phosphor-icons/react";
import { useMemo, useState } from "react";
import type { SessionScope } from "../../core/entities/sessionFilter";
import { filterSessions, scopeCounts } from "../../core/entities/sessionFilter";
import type { HistoryItem } from "../../core/usecases/history";

interface Props {
  sessions: readonly HistoryItem[];
  /** True when any are the agent's own sessions (opening = true resume). */
  native: boolean;
  /** True while the list is being fetched from the local store. */
  loading: boolean;
  /** Why the list is empty when it's a failure, not an absence. */
  error?: string;
  activeSessionId?: string;
  busy: boolean;
  onOpen: (item: HistoryItem) => void;
  onDelete: (item: HistoryItem) => void;
  onNewChat: () => void;
  onRefresh: () => void;
}

/** UI — previous conversations of this project; click one to reopen it. */
export function HistoryPanel({
  sessions,
  native,
  loading,
  error,
  activeSessionId,
  busy,
  onOpen,
  onDelete,
  onNewChat,
  onRefresh,
}: Props) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<SessionScope>("all");

  const counts = useMemo(() => scopeCounts(sessions), [sessions]);
  const shown = useMemo(
    () => filterSessions(sessions, query, scope),
    [sessions, query, scope],
  );
  // The toggles are worth their row only where there is something to
  // toggle: a project without worktrees has one kind of session.
  const hasWorktreeSessions = counts.worktrees > 0;

  return (
    <aside className="history">
      <div className="history__toolbar">
        <button
          type="button"
          className="changes__action"
          disabled={busy}
          onClick={onNewChat}
        >
          + New chat
        </button>
        <button
          type="button"
          className="changes__action changes__action--icon"
          disabled={busy || loading}
          aria-label="Refresh sessions"
          title="Refresh the session list"
          onClick={onRefresh}
        >
          <ArrowsClockwise />
        </button>
      </div>

      {sessions.length > 0 && (
        <div className="history__search">
          <MagnifyingGlass size={13} aria-hidden="true" />
          <input
            className="history__search-input"
            type="search"
            placeholder="Search sessions…"
            aria-label="Search sessions"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}
      {hasWorktreeSessions && (
        <SessionScopeToggle scope={scope} counts={counts} onSelect={setScope} />
      )}

      {native && sessions.length > 0 && (
        <p className="history__source">
          From the agent's own history — opening resumes with full memory.
        </p>
      )}
      {loading && sessions.length === 0 && (
        <p className="changes__empty history__loading">Loading sessions…</p>
      )}
      {!loading && error && (
        <p className="changes__notice changes__notice--error">
          Could not load the agent's sessions: {error}
        </p>
      )}
      {!loading && !error && sessions.length === 0 && (
        <p className="changes__empty">No saved sessions for this project yet.</p>
      )}
      {sessions.length > 0 && shown.length === 0 && (
        <p className="changes__empty">Nothing matches that search.</p>
      )}
      <ul className="history__list">
        {shown.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            active={session.id === activeSessionId}
            busy={busy}
            onOpen={() => onOpen(session)}
            onDelete={() => onDelete(session)}
          />
        ))}
      </ul>
    </aside>
  );
}

const SCOPES: readonly { scope: SessionScope; label: string }[] = [
  { scope: "all", label: "All" },
  { scope: "own", label: "This folder" },
  { scope: "worktrees", label: "Worktrees" },
];

/** Which checkouts' sessions the list is showing, and how many each has. */
function SessionScopeToggle({
  scope,
  counts,
  onSelect,
}: {
  scope: SessionScope;
  counts: ReturnType<typeof scopeCounts>;
  onSelect: (scope: SessionScope) => void;
}) {
  return (
    <div className="history__scopes">
      {SCOPES.map((option) => (
        <button
          key={option.scope}
          type="button"
          className={`history__scope ${
            scope === option.scope ? "history__scope--on" : ""
          }`}
          aria-pressed={scope === option.scope}
          title={`Show ${option.label.toLowerCase()} sessions`}
          onClick={() => onSelect(option.scope)}
        >
          {option.label}
          <span className="history__scope-count">{counts[option.scope]}</span>
        </button>
      ))}
    </div>
  );
}

function SessionRow({
  session,
  active,
  busy,
  onOpen,
  onDelete,
}: {
  session: HistoryItem;
  active: boolean;
  busy: boolean;
  onOpen: () => void;
  onDelete: () => void;
}) {
  return (
    <li
      className={`history__item ${active ? "history__item--active" : ""}`}
      onClick={() => !busy && onOpen()}
      title={sessionTitle(session)}
    >
      <div className="history__title">{session.title}</div>
      <div className="history__meta">
        <span>{formatWhen(session.savedAt)}</span>
        {/* Which checkout this conversation was had in. Only ever on the
            main checkout's tab: a worktree lists its own and needs no
            badge to say whose they are. */}
        {session.from && (
          <span className="history__worktree">
            <GitFork size={10} aria-hidden="true" />
            {session.from.label}
          </span>
        )}
        <span className="history__provider">{session.provider}</span>
        {/* Ours to delete only when the copy on disk is ours. */}
        {session.local && (
          <button
            type="button"
            className="history__delete"
            title="Delete this session"
            aria-label="Delete session"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
          >
            ×
          </button>
        )}
      </div>
    </li>
  );
}

/** The row's tooltip: what it holds, and where clicking would take you. */
function sessionTitle(session: HistoryItem): string {
  const counted =
    session.messageCount !== undefined
      ? `${session.messageCount} messages · ${session.provider}`
      : session.provider;
  return session.from
    ? `${counted}\nIn the worktree ${session.from.path}\nOpens that worktree's tab`
    : counted;
}

function formatWhen(savedAt: number): string {
  if (!savedAt) return "";
  const minutes = Math.floor((Date.now() - savedAt) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(savedAt).toLocaleDateString();
}
