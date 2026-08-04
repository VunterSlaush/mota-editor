import type { ChatMessage } from "./message";

/**
 * Entities layer — what the agents' tools do to the working tree.
 *
 * The workbench drives three CLIs that each name their tools differently
 * (Claude's `Edit`, Codex's `apply_patch`, Gemini's `replace`), so this
 * matches on fragments rather than an exact list: a new tool called
 * `edit_notebook` counts without anyone editing this file.
 */

/** Tools that only ever look. Checked first — `TodoWrite` writes a list, not a file. */
const READ_ONLY = ["read", "grep", "glob", "fetch", "todo", "task"];

/** Name fragments that mean "the working tree may have moved". */
const CHANGING = [
  "edit",
  "write",
  "patch",
  "replace",
  "create",
  "delete",
  "remove",
  "rename",
  "move",
  // A shell can do anything, so assume it did.
  "bash",
  "shell",
  "terminal",
  "command",
];

/**
 * Whether running this tool could have changed a file on disk. A
 * heuristic on purpose: a false positive costs one `git status`, while a
 * false negative leaves the user looking at a stale diff.
 */
export function changesFiles(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const name = toolName.toLowerCase();
  if (READ_ONLY.some((fragment) => name.includes(fragment))) return false;
  return CHANGING.some((fragment) => name.includes(fragment));
}

/**
 * How many file-changing tools this conversation has run. The Changes
 * panel watches this number and reloads git when it moves.
 */
export function countFileChangingTools(messages: readonly ChatMessage[]): number {
  return messages.filter((m) => m.role === "tool" && changesFiles(m.toolName)).length;
}
