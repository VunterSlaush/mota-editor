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

/** An outcome split into the sentence to read and the git output behind it. */
export interface NoticeParts {
  /** One line, in words: what happened, or what to do about it. */
  readonly headline: string;
  /** git's own report, or "" when it had nothing to add. */
  readonly detail: string;
}

/**
 * A result message split for display.
 *
 * The backend writes both halves into one string — a headline, a blank
 * line, then git's own words — because that is what crosses the boundary
 * as a single `message`. Rendering them as one paragraph is what made
 * the notice a wall: the sentence that matters got the same size, colour
 * and weight as the ref hashes underneath it.
 */
export function noticeParts(message: string): NoticeParts {
  const text = message.trim();
  const blankLine = text.indexOf("\n\n");
  if (blankLine === -1) {
    // No detail was offered. A message that is itself several lines is
    // still one thing to read, so it stays whole rather than being cut
    // at its first newline.
    return { headline: text, detail: "" };
  }
  return {
    headline: text.slice(0, blankLine).trim(),
    detail: text.slice(blankLine + 2).trim(),
  };
}
