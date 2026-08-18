import type { CheckpointChange, CheckpointStat } from "../ports/checkpointPort";
import type { ChatMessage } from "./message";

/**
 * Entities layer — the rules of `/rewind`: which turns can be rewound
 * to, and how the result is described. No I/O, no git.
 */

/** A turn the user can go back to. */
export interface RewindPoint {
  /** The prompt message this checkpoint was taken for. */
  readonly messageId: string;
  /** Opaque handle the port hands back. */
  readonly checkpoint: string;
  /** The prompt text, for the picker. */
  readonly prompt: string;
  readonly sentAt: number;
}

/**
 * The turns worth offering, newest first — a rewind is a walk backwards,
 * so the list reads in the order it is used.
 *
 * Only user prompts that carried a checkpoint qualify. A turn sent
 * before the project was a git repository, or one whose snapshot timed
 * out, has nothing to restore and is simply absent rather than shown as
 * a dead entry.
 */
export function rewindPoints(messages: readonly ChatMessage[]): readonly RewindPoint[] {
  const points: RewindPoint[] = [];
  for (const message of messages) {
    const checkpoint = message.turn?.checkpoint;
    if (message.role !== "user" || !checkpoint || !message.turn) continue;
    points.push({
      messageId: message.id,
      checkpoint,
      prompt: message.text,
      sentAt: message.turn.sentAt,
    });
  }
  return points.reverse();
}

/**
 * Nothing to undo. Worth its own question because it is the common case
 * for a turn that only read files, and the answer is "say so", not "show
 * an empty confirm dialog".
 */
export function isUnchanged(stat: CheckpointStat): boolean {
  return stat.files === 0 && stat.insertions === 0 && stat.deletions === 0;
}

/** "7 files · +12 −4", or "1 file · +3" when nothing was removed. */
export function describeStat(stat: CheckpointStat): string {
  const files = `${stat.files} ${stat.files === 1 ? "file" : "files"}`;
  const counts = [
    stat.insertions > 0 ? `+${stat.insertions}` : "",
    stat.deletions > 0 ? `-${stat.deletions}` : "",
  ].filter(Boolean);
  return counts.length > 0 ? `${files} · ${counts.join(" ")}` : files;
}

/**
 * The sentence the confirm dialog leads with. Deletions are named
 * separately and first: overwriting a file the agent changed is what the
 * user asked for, but removing one it created is the part they have to
 * agree to knowingly.
 */
export function describeRestore(changes: readonly CheckpointChange[]): string {
  const deletes = changes.filter((c) => c.fate === "delete").length;
  const restores = changes.length - deletes;
  const parts: string[] = [];
  if (restores > 0) {
    parts.push(`${restores} ${restores === 1 ? "file" : "files"} restored`);
  }
  if (deletes > 0) {
    parts.push(`${deletes} created since then ${deletes === 1 ? "is" : "are"} deleted`);
  }
  return parts.join(", ");
}

/**
 * What the transcript records after a rewind.
 *
 * It says the conversation is untouched on purpose. The agent's context
 * still contains every edit it made, so its next answer will talk about
 * code that is no longer on disk unless the user knows to say otherwise.
 * Leaving that unsaid is the one way this feature can mislead.
 */
export function rewindNotice(stat: CheckpointStat): string {
  if (isUnchanged(stat)) {
    return "Nothing to rewind — no files changed since that message.";
  }
  return `Files rewound to before that message (${describeStat(stat)}). The conversation is unchanged, so the agent still believes it made those edits — tell it what you undid.`;
}
