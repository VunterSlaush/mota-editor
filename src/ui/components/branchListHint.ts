import type { BranchMatches } from "../../core/entities/branch";

/**
 * UI text — the line under a branch list, naming what the list is not
 * showing. Both pickers cap their rows, and a capped list that says
 * nothing reads as "that is all there is"; the remote branches an empty
 * query leaves out are invisible until someone is told they can be
 * searched for. Null when the list is showing everything there is.
 */
export function branchListHint(matches: BranchMatches<unknown>): string | null {
  const notes: string[] = [];
  if (matches.total > matches.shown.length) {
    notes.push(`Showing ${matches.shown.length} of ${matches.total} branches`);
  }
  if (matches.remotesHidden > 0) {
    notes.push(`Type to search ${remoteCount(matches.remotesHidden)}`);
  }
  return notes.length > 0 ? notes.join(" · ") : null;
}

function remoteCount(remotes: number): string {
  return remotes === 1 ? "1 remote branch" : `${remotes} remote branches`;
}
