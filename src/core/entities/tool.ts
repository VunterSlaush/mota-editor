import type { ChatMessage } from "./message";

/** One file the agent reported editing, with its diff when it sent one. */
export interface AgentEditedFile {
  readonly path: string;
  readonly diff?: { readonly oldText?: string; readonly newText: string };
}

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

/** Whether an ACP tool call plausibly touched the working tree: it
 *  reported a diff or edit-flavoured locations, or its kind says so. */
function toolCallChangesFiles(message: ChatMessage): boolean {
  const call = message.toolCall;
  if (!call) return false;
  if (call.content.some((item) => item.type === "diff")) return true;
  return ["edit", "delete", "move", "execute"].includes(call.toolKind);
}

/**
 * How many file-changing tools this conversation has run. The Changes
 * panel watches this number and reloads git when it moves. ACP tool
 * calls answer from their reported kind/diffs; legacy rows fall back to
 * the name heuristic.
 */
export function countFileChangingTools(messages: readonly ChatMessage[]): number {
  return messages.filter(
    (m) =>
      m.role === "tool" &&
      (m.toolCall ? toolCallChangesFiles(m) : changesFiles(m.toolName)),
  ).length;
}

/**
 * The files the agent itself reported editing this session, newest diff
 * per path winning. First-hand knowledge for the Changes panel — unlike
 * git, this survives the file being reverted-and-re-edited and needs no
 * guessing about which tool touched what.
 */
export function agentEditedFiles(
  messages: readonly ChatMessage[],
): readonly AgentEditedFile[] {
  const byPath = new Map<string, AgentEditedFile>();
  for (const message of messages) {
    const call = message.toolCall;
    if (!call) continue;
    for (const item of call.content) {
      if (item.type === "diff") {
        byPath.set(item.path, {
          path: item.path,
          diff: { oldText: item.oldText, newText: item.newText },
        });
      }
    }
    if (call.toolKind === "edit") {
      for (const location of call.locations) {
        if (!byPath.has(location.path))
          byPath.set(location.path, { path: location.path });
      }
    }
  }
  return [...byPath.values()];
}
