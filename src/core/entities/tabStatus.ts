import type { ChatMessage } from "./message";

/**
 * Entities layer — what a project tab's indicator should say at a glance.
 *
 * The tab bar is the only place a background project speaks, so the order
 * below is deliberate: it answers "which tab needs ME?" before "which tab
 * is doing something?".
 */
export type TabStatus =
  /** The agent is blocked on the user: approval, plan, or a question. */
  | "needsInput"
  /** The last turn failed. */
  | "error"
  /** A turn is running and nothing is waiting on the user. */
  | "busy"
  /** Finished while the user was on another tab. */
  | "done"
  /** Nothing to say. */
  | "idle";

/** True while an approval or question is on screen with no answer yet. */
export function hasPendingRequest(messages: readonly ChatMessage[]): boolean {
  return messages.some((m) => {
    if (m.approval) {
      return m.approval.resolvedOptionId === undefined && !m.approval.cancelled;
    }
    if (m.question) {
      return (
        m.question.answers === undefined && !m.question.skipped && !m.question.cancelled
      );
    }
    return false;
  });
}

/** True when the conversation ended on a failure. */
function endedInError(messages: readonly ChatMessage[]): boolean {
  // Tool/thought/info rows are noise trailing an error; look past them.
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const role = messages[i].role;
    if (role === "error") return true;
    if (role === "assistant" || role === "user" || role === "approval") return false;
    if (role === "question") return false;
  }
  return false;
}

/**
 * The tab's indicator state.
 *
 * `needsInput` outranks everything, including `busy`: a turn awaiting an
 * approval is still technically running, but what matters is that it has
 * stopped and is waiting for a person. `error` outranks `done` for the
 * same reason — "it finished" is true but useless if it finished badly.
 */
export function tabStatus(tab: {
  readonly messages: readonly ChatMessage[];
  readonly busy: boolean;
  readonly attention?: boolean;
}): TabStatus {
  if (hasPendingRequest(tab.messages)) return "needsInput";
  if (endedInError(tab.messages) && !tab.busy) return "error";
  if (tab.busy) return "busy";
  if (tab.attention) return "done";
  return "idle";
}

/**
 * True while this tab has agent work in flight — a turn running, or
 * prompts queued behind it.
 *
 * Narrower than "not idle" on purpose: an unanswered approval or a
 * failed turn is a tab you can walk away from, while a running turn
 * dies with the process and cannot be got back. This is what a close
 * has to stop and ask about.
 */
export function tabIsWorking(tab: {
  readonly busy: boolean;
  readonly queued: readonly unknown[];
}): boolean {
  return tab.busy || tab.queued.length > 0;
}

/** Screen-reader / tooltip wording for each state. */
export const TAB_STATUS_LABELS: Readonly<Record<TabStatus, string>> = {
  needsInput: "waiting for you",
  error: "last turn failed",
  busy: "working",
  done: "finished — needs review",
  idle: "",
};
