/**
 * Entities — which branches the checkout picker offers for what the user
 * has typed.
 *
 * A repository that has been fetched a few hundred times carries
 * thousands of remote-tracking refs, and a picker that turned every one
 * of them into a row froze the app on open. Two rules keep the list
 * small without hiding anything: nothing remote is listed until
 * something is typed, and the matches are capped. What was left out is
 * part of the answer, so the picker can say so rather than silently
 * truncating.
 */

/** How many rows the branch picker ever shows. */
export const BRANCH_LIST_LIMIT = 50;

/** The part of a branch that matching reads. */
export interface MatchableBranch {
  readonly name: string;
  readonly current: boolean;
  /** Exists only on a remote so far. */
  readonly remote?: boolean;
}

/** The rows to draw, and what did not fit in them. */
export interface BranchMatches<T> {
  readonly shown: readonly T[];
  /** Every branch that matched, the shown ones included. */
  readonly total: number;
  /** Remote branches an empty query does not list; 0 while searching. */
  readonly remotesHidden: number;
}

/**
 * The branches to offer for `query`, best match first, at most `limit`.
 * An empty query lists local branches only — the ones the user works on
 * — while a query reaches the remote-only ones too, because searching
 * for a colleague's branch by name is how you check it out the first
 * time. Matching is plain case-insensitive substring: never a "match"
 * the user cannot see in the row.
 */
export function filterBranches<T extends MatchableBranch>(
  branches: readonly T[],
  query: string,
  limit = BRANCH_LIST_LIMIT,
): BranchMatches<T> {
  const typed = query.trim().toLowerCase();
  if (typed === "") return localBranches(branches, limit);

  const matched = branchesMatching(branches, typed);
  return { shown: matched.slice(0, limit), total: matched.length, remotesHidden: 0 };
}

/** The unsearched list: locals, the current one first. */
function localBranches<T extends MatchableBranch>(
  branches: readonly T[],
  limit: number,
): BranchMatches<T> {
  const locals = branches.filter((b) => !b.remote);
  // A stable sort, so git's own order — most recent first — survives
  // underneath the current branch.
  const ordered = [...locals].sort((a, b) => Number(b.current) - Number(a.current));
  return {
    shown: ordered.slice(0, limit),
    total: locals.length,
    remotesHidden: branches.length - locals.length,
  };
}

function branchesMatching<T extends MatchableBranch>(
  branches: readonly T[],
  query: string,
): T[] {
  const ranked: { branch: T; rank: number }[] = [];
  for (const branch of branches) {
    const tier = rank(branch.name.toLowerCase(), query);
    if (tier !== null) ranked.push({ branch, rank: (branch.remote ? TIERS : 0) + tier });
  }
  // Stable again: equally good matches keep git's recency order.
  ranked.sort((a, b) => a.rank - b.rank);
  return ranked.map((r) => r.branch);
}

/** How many tiers `rank` has, and so what being remote costs. */
const TIERS = 3;

/**
 * Lower is better; null means no match at all. The last segment gets a
 * tier of its own because `feature/login` is the branch someone typing
 * "login" means, and the prefix they left out is a folder, not a name.
 */
function rank(name: string, query: string): number | null {
  const leaf = name.slice(name.lastIndexOf("/") + 1);
  if (name.startsWith(query)) return 0;
  if (leaf.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return null;
}
