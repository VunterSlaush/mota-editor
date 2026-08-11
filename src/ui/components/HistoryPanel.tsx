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
  onDelete: (sessionId: string) => void;
  onNewChat: () => void;
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
}: Props) {
  return (
    <aside className="history">
      <button
        type="button"
        className="changes__action"
        disabled={busy}
        onClick={onNewChat}
      >
        + New chat
      </button>
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
      <ul className="history__list">
        {sessions.map((session) => (
          <li
            key={session.id}
            className={`history__item ${
              session.id === activeSessionId ? "history__item--active" : ""
            }`}
            onClick={() => !busy && onOpen(session)}
            title={
              session.messageCount !== undefined
                ? `${session.messageCount} messages · ${session.provider}`
                : session.provider
            }
          >
            <div className="history__title">{session.title}</div>
            <div className="history__meta">
              <span>{formatWhen(session.savedAt)}</span>
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
                    onDelete(session.id);
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </aside>
  );
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
