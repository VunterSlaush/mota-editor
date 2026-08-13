/**
 * Entities — which of the listed sessions the history panel shows, for
 * what has been typed and which checkouts are toggled on.
 *
 * The panel lists a repository's conversations, not a folder's, so it
 * can run to hundreds of rows across several worktrees. Both filters are
 * plain and visible: a substring the user can see in the row, and a
 * scope the toggles name — never a "match" that has to be explained.
 */

/** Which checkouts' sessions a history list is showing. */
export type SessionScope = "all" | "own" | "worktrees";

/** The parts of a history row that filtering reads. */
export interface FilterableSession {
  readonly title: string;
  /**
   * The other checkout this session belongs to. Absent means the tab's
   * own folder — the distinction the scope toggles are made of.
   */
  readonly from?: { readonly label: string };
}

/** How many rows each scope would show; the toggles say so out loud. */
export interface ScopeCounts {
  readonly all: number;
  readonly own: number;
  readonly worktrees: number;
}

/**
 * The sessions to draw: those in `scope` whose title — or the worktree
 * they came from — contains `query`. Searching by worktree matters
 * because "which chats did I have in feature/polish?" is the question
 * the worktree badge provokes.
 */
export function filterSessions<T extends FilterableSession>(
  sessions: readonly T[],
  query: string,
  scope: SessionScope,
): T[] {
  const typed = query.trim().toLowerCase();
  return sessions.filter((session) => inScope(session, scope) && matches(session, typed));
}

export function scopeCounts(sessions: readonly FilterableSession[]): ScopeCounts {
  const worktrees = sessions.filter((session) => session.from !== undefined).length;
  return { all: sessions.length, own: sessions.length - worktrees, worktrees };
}

function inScope(session: FilterableSession, scope: SessionScope): boolean {
  if (scope === "own") return session.from === undefined;
  if (scope === "worktrees") return session.from !== undefined;
  return true;
}

function matches(session: FilterableSession, typed: string): boolean {
  if (typed === "") return true;
  if (session.title.toLowerCase().includes(typed)) return true;
  return session.from?.label.toLowerCase().includes(typed) ?? false;
}
