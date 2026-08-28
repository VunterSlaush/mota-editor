import { APP_VERSION } from "../version";

/** UI — shown when no project tab is open yet. */
export function EmptyState({ onOpenProject }: { onOpenProject: () => void }) {
  return (
    <main className="empty-state">
      <h1>
        Mota Editor <span className="empty-state__version">{APP_VERSION}</span>
      </h1>
      <p>One tab per project. One agent per tab.</p>
      <button type="button" className="empty-state__button" onClick={onOpenProject}>
        Open a project folder
      </button>
      <p className="empty-state__hint">
        Works with the agent CLIs you already have — sign in to each one once in a
        terminal, then use them from here. OpenCode needs no account: its free models work
        as soon as it is installed.
      </p>
    </main>
  );
}
