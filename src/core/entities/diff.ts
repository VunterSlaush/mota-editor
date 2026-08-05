/**
 * Entities layer — reading `git diff` output.
 *
 * Git speaks unified diff: a header, then hunks of `@@` ranges whose
 * lines are prefixed with a space (context), `-` (removed) or `+`
 * (added). The viewer wants two columns instead, so this also pairs each
 * hunk's removals with the additions that replaced them.
 */

export type DiffLineKind = "context" | "add" | "remove";

export interface DiffLine {
  readonly kind: DiffLineKind;
  readonly text: string;
  /** Line number in the old file; absent for additions. */
  readonly oldNo?: number;
  /** Line number in the new file; absent for removals. */
  readonly newNo?: number;
}

export interface DiffHunk {
  /** The `@@ -a,b +c,d @@` line, section heading and all. */
  readonly header: string;
  readonly lines: readonly DiffLine[];
}

/** One row of the side-by-side view; either side may be empty. */
export interface SideRow {
  readonly left?: DiffLine;
  readonly right?: DiffLine;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Parse unified diff text into hunks. Everything before the first `@@`
 * (the `diff --git`, `index`, `---`/`+++` preamble) is dropped: the
 * viewer already knows which file it is showing.
 */
export function parseUnifiedDiff(text: string): readonly DiffHunk[] {
  const hunks: DiffHunk[] = [];
  let header: string | null = null;
  let lines: DiffLine[] = [];
  let oldNo = 0;
  let newNo = 0;

  const flush = () => {
    if (header !== null) hunks.push({ header, lines });
  };

  for (const raw of text.split("\n")) {
    const match = HUNK_HEADER.exec(raw);
    if (match) {
      flush();
      header = raw;
      lines = [];
      oldNo = Number(match[1]);
      newNo = Number(match[2]);
      continue;
    }
    if (header === null) continue; // still in the preamble

    // "\ No newline at end of file" annotates the previous line rather
    // than being one of its own.
    if (raw.startsWith("\\")) continue;

    if (raw.startsWith("+")) {
      lines.push({ kind: "add", text: raw.slice(1), newNo });
      newNo += 1;
    } else if (raw.startsWith("-")) {
      lines.push({ kind: "remove", text: raw.slice(1), oldNo });
      oldNo += 1;
    } else if (raw.startsWith(" ") || raw === "") {
      // git writes a bare empty line for an empty context line.
      lines.push({ kind: "context", text: raw.slice(1), oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
    // Anything else (a stray truncation notice, say) is not diff content.
  }
  flush();
  return hunks;
}

/**
 * Lay a hunk out in two columns. Context sits on both sides; a run of
 * removals is paired position-by-position with the run of additions that
 * follows it, so a changed line reads across rather than down. Whichever
 * run is longer spills into rows with one side blank.
 */
export function toSideBySide(hunk: DiffHunk): readonly SideRow[] {
  const rows: SideRow[] = [];
  let index = 0;

  while (index < hunk.lines.length) {
    const line = hunk.lines[index];
    if (line.kind === "context") {
      rows.push({ left: line, right: line });
      index += 1;
      continue;
    }

    const removals: DiffLine[] = [];
    while (hunk.lines[index]?.kind === "remove") {
      removals.push(hunk.lines[index]);
      index += 1;
    }
    const additions: DiffLine[] = [];
    while (hunk.lines[index]?.kind === "add") {
      additions.push(hunk.lines[index]);
      index += 1;
    }

    for (let i = 0; i < Math.max(removals.length, additions.length); i += 1) {
      rows.push({ left: removals[i], right: additions[i] });
    }
  }
  return rows;
}

/** How many lines the diff adds and removes, for a one-line summary. */
export function countChanges(hunks: readonly DiffHunk[]): {
  readonly added: number;
  readonly removed: number;
} {
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    for (const line of hunk.lines) {
      if (line.kind === "add") added += 1;
      else if (line.kind === "remove") removed += 1;
    }
  }
  return { added, removed };
}
