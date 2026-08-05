import type { DiffHunk, DiffLine } from "./diff";

/**
 * Entities layer — diff two whole texts into the same `DiffHunk` shape
 * `git diff` parses into, so the agent's reported file changes (ACP diff
 * content: full old/new text) render in the existing viewer unchanged.
 */

/** Context lines kept around each change, like git's default. */
const CONTEXT = 3;

/**
 * Past this many lines per side the exact diff (O(n·m)) is not worth
 * computing for a chat view; the change collapses to one replace block.
 */
const EXACT_DIFF_LIMIT = 5000;

export function diffTexts(oldText: string, newText: string): readonly DiffHunk[] {
  const oldLines = splitLines(oldText);
  const newLines = splitLines(newText);

  // Common prefix/suffix cost nothing and shrink the LCS problem.
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start += 1;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > start &&
    newEnd > start &&
    oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const lines = [
    ...contextLines(oldLines, 0, start, 1, 1),
    ...changedLines(
      oldLines.slice(start, oldEnd),
      newLines.slice(start, newEnd),
      start + 1,
      start + 1,
    ),
    ...contextLines(oldLines, oldEnd, oldLines.length, oldEnd + 1, newEnd + 1),
  ];
  return toHunks(lines);
}

function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  // A trailing newline produces a phantom empty last element.
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function contextLines(
  lines: readonly string[],
  from: number,
  to: number,
  oldNo: number,
  newNo: number,
): DiffLine[] {
  const result: DiffLine[] = [];
  for (let i = from; i < to; i += 1) {
    result.push({
      kind: "context",
      text: lines[i],
      oldNo: oldNo + (i - from),
      newNo: newNo + (i - from),
    });
  }
  return result;
}

/** Diff the changed middle: exact LCS when affordable, else one block. */
function changedLines(
  oldLines: readonly string[],
  newLines: readonly string[],
  oldNo: number,
  newNo: number,
): DiffLine[] {
  if (oldLines.length === 0 && newLines.length === 0) return [];
  if (oldLines.length > EXACT_DIFF_LIMIT || newLines.length > EXACT_DIFF_LIMIT) {
    return replaceBlock(oldLines, newLines, oldNo, newNo);
  }

  // Standard LCS table, backtracked into remove/add/context runs.
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const lcs = new Uint32Array(rows * cols);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] =
        oldLines[i] === newLines[j]
          ? lcs[(i + 1) * cols + j + 1] + 1
          : Math.max(lcs[(i + 1) * cols + j], lcs[i * cols + j + 1]);
    }
  }

  const result: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < oldLines.length && j < newLines.length) {
    if (oldLines[i] === newLines[j]) {
      result.push({
        kind: "context",
        text: oldLines[i],
        oldNo: oldNo + i,
        newNo: newNo + j,
      });
      i += 1;
      j += 1;
    } else if (lcs[(i + 1) * cols + j] >= lcs[i * cols + j + 1]) {
      result.push({ kind: "remove", text: oldLines[i], oldNo: oldNo + i });
      i += 1;
    } else {
      result.push({ kind: "add", text: newLines[j], newNo: newNo + j });
      j += 1;
    }
  }
  while (i < oldLines.length) {
    result.push({ kind: "remove", text: oldLines[i], oldNo: oldNo + i });
    i += 1;
  }
  while (j < newLines.length) {
    result.push({ kind: "add", text: newLines[j], newNo: newNo + j });
    j += 1;
  }
  return result;
}

function replaceBlock(
  oldLines: readonly string[],
  newLines: readonly string[],
  oldNo: number,
  newNo: number,
): DiffLine[] {
  return [
    ...oldLines.map((text, k) => ({
      kind: "remove" as const,
      text,
      oldNo: oldNo + k,
    })),
    ...newLines.map((text, k) => ({ kind: "add" as const, text, newNo: newNo + k })),
  ];
}

/** Group a full-file line list into hunks with CONTEXT lines around
 *  changes, headers in git's `@@ -a,b +c,d @@` shape. */
function toHunks(lines: readonly DiffLine[]): DiffHunk[] {
  const changed = lines.some((l) => l.kind !== "context");
  if (!changed) return [];

  const hunks: DiffHunk[] = [];
  let current: DiffLine[] = [];
  let sinceChange = Number.POSITIVE_INFINITY;

  const flush = () => {
    // Drop the trailing context beyond CONTEXT lines.
    while (
      current.length > 0 &&
      current[current.length - 1].kind === "context" &&
      sinceChange > CONTEXT
    ) {
      current.pop();
      sinceChange -= 1;
    }
    if (current.some((l) => l.kind !== "context")) hunks.push(makeHunk(current));
    current = [];
  };

  for (const line of lines) {
    if (line.kind === "context") {
      sinceChange += 1;
      current.push(line);
      // A long calm stretch splits hunks: keep CONTEXT lines of trail,
      // start collecting lead context for the next change.
      if (sinceChange === CONTEXT * 2 + 1) {
        flush();
        current = [];
      }
      if (current.length > CONTEXT && current.every((l) => l.kind === "context")) {
        current.shift();
      }
    } else {
      sinceChange = 0;
      current.push(line);
    }
  }
  flush();
  return hunks;
}

function makeHunk(lines: DiffLine[]): DiffHunk {
  const oldStart = lines.find((l) => l.oldNo !== undefined)?.oldNo ?? 1;
  const newStart = lines.find((l) => l.newNo !== undefined)?.newNo ?? 1;
  const oldCount = lines.filter((l) => l.kind !== "add").length;
  const newCount = lines.filter((l) => l.kind !== "remove").length;
  return {
    header: `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
    lines: [...lines],
  };
}
