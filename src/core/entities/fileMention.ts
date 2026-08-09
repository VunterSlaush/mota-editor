/**
 * Entities — the "@" file reference typed into the composer.
 *
 * The rules mirror the slash-command palette's: whitespace delimits the
 * token, so the menu opens on the word being typed and closes as soon as
 * it is finished.
 */

/** How many rows the "@" menu ever shows. */
export const FILE_MENTION_LIMIT = 50;

/**
 * The "@..." word at the end of the draft, "@" included, or null. A token
 * that merely contains an "@" (an email address) is ordinary text.
 */
export function mentionToken(draft: string): string | null {
  const token = draft.split(/\s/).pop() ?? "";
  return token.startsWith("@") ? token : null;
}

/**
 * Project files matching the typed token ("@" optional), best match
 * first, at most `limit`. Matching is plain case-insensitive substring:
 * one pass per path, no scoring knobs, and never a "match" the user
 * cannot see in the row.
 */
export function filterFiles(
  paths: readonly string[],
  typed: string,
  limit: number,
): string[] {
  const query = typed.replace(/^@/, "").toLowerCase();
  if (query === "") return paths.slice(0, limit);

  const ranked: { path: string; tier: number }[] = [];
  for (const path of paths) {
    const tier = rank(path, query);
    if (tier !== null) ranked.push({ path, tier });
  }
  // A name match beats a folder match, and among equals the shallower
  // path wins — the file you meant is rarely the deepest one.
  ranked.sort(
    (a, b) =>
      a.tier - b.tier || a.path.length - b.path.length || a.path.localeCompare(b.path),
  );
  return ranked.slice(0, limit).map((r) => r.path);
}

/**
 * The draft with its trailing @token swapped for `path`, plus the space
 * that closes the menu. The path goes in raw: this is a prompt for an
 * agent, not a shell command line, and quoting it would both litter the
 * message and defeat the agents' own "@path" recognition.
 */
export function replaceMention(draft: string, token: string, path: string): string {
  return `${draft.slice(0, draft.length - token.length)}${path} `;
}

/** Lower is better; null means no match at all. */
function rank(path: string, query: string): number | null {
  const lower = path.toLowerCase();
  const name = lower.slice(lower.lastIndexOf("/") + 1);
  if (name.startsWith(query)) return 0;
  if (lower.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  if (lower.includes(query)) return 3;
  return null;
}
