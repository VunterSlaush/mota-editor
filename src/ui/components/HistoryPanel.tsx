import { ArrowsClockwise, GitFork, MagnifyingGlass } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionScope } from "../../core/entities/sessionFilter";
import {
  filterSessions,
  matchedKeyword,
  scopeCounts,
} from "../../core/entities/sessionFilter";
import type { HistoryItem } from "../../core/usecases/history";

interface Props {
  sessions: readonly HistoryItem[];
  /**
   * What each session was about, by id — read once, the first time a
   * search is run, because it is the one expensive read here.
   */
  loadKeywords: () => Promise<Map<string, readonly string[]>>;
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
  loadKeywords,
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
  const [keywords, setKeywords] = useState<Map<string, readonly string[]> | null>(null);
  const [indexing, setIndexing] = useState(false);
  // Asked for exactly once per mounting of this panel: the answer costs
  // a walk of every transcript, and it does not change while you type.
  const asked = useRef(false);

  // The first keystroke is what pays for the index — a panel that is
  // only ever opened and read never pays at all.
  const searching = query.trim() !== "";
  useEffect(() => {
    if (!searching || asked.current) return;
    asked.current = true;
    let cancelled = false;
    setIndexing(true);
    loadKeywords()
      .then((loaded) => {
        if (!cancelled) setKeywords(loaded);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setIndexing(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searching]);

  const counts = useMemo(() => scopeCounts(sessions), [sessions]);
  // The rows the filter actually sees: their themes, once known.
  const indexed = useMemo(
    () =>
      keywords ? sessions.map((s) => ({ ...s, keywords: keywords.get(s.id) })) : sessions,
    [sessions, keywords],
  );
  const shown = useMemo(
    () => filterSessions(indexed, query, scope),
    [indexed, query, scope],
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
      {sessions.length > 0 && shown.length === 0 && !indexing && (
        <p className="changes__empty">Nothing matches that search.</p>
      )}
      {indexing && (
        <p className="changes__empty history__loading">
          Reading what these conversations were about…
        </p>
      )}
      <ul className="history__list">
        {shown.map((session) => (
          <SessionRow
            key={session.id}
            session={session}
            active={session.id === activeSessionId}
            busy={busy}
            theme={matchedKeyword(session, query)}
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
  theme,
  onOpen,
  onDelete,
}: {
  session: HistoryItem;
  active: boolean;
  busy: boolean;
  /** The word this row matched on, when the row does not show it. */
  theme?: string;
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
        {/* Why this row is here at all, when its title does not say. */}
        {theme && (
          <span
            className="history__theme"
            title={`This conversation is about "${theme}"`}
          >
            {theme}
          </span>
        )}
        {/* That this conversation happened in a worktree is true wherever
            the row is listed — on the worktree's own tab as much as on
            the main checkout that borrowed it. */}
        {session.from?.worktree && (
          <span className="history__worktree" title={session.from.path}>
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
  if (!session.from?.elsewhere) return counted;
  return `${counted}\nIn the worktree ${session.from.path}\nOpens that worktree's tab`;
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
