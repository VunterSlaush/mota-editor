/**
 * Entity — a git verb the Changes panel runs, and how the last one
 * ended. Both live in the tab's state rather than the panel's, because
 * switching tabs remounts the panel: a push that takes ten seconds must
 * still read as running when the user comes back to it.
 */

/** The verb in flight. `file` is any single move of the index — staging
 *  or unstaging, one file or all of them. */
export type GitVerb = "fetch" | "pull" | "push" | "commit" | "file";

/** Outcome of a git verb, ready for display. */
export interface GitActionResult {
  readonly ok: boolean;
  readonly message: string;
}
