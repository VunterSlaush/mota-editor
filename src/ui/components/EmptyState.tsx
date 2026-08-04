/** UI — shown when no project tab is open yet. */
export function EmptyState({ onOpenProject }: { onOpenProject: () => void }) {
  return (
    <main className="empty-state">
      <h1>Mota Editor</h1>
      <p>One tab per project. One agent per tab.</p>
      <button className="empty-state__button" onClick={onOpenProject}>
        Open a project folder
      </button>
      <p className="empty-state__hint">
        Works with the Claude, Codex (ChatGPT) and Gemini CLIs — sign in to each
        one once in a terminal, then use them from here.
      </p>
    </main>
  );
}
