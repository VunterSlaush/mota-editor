import type { ApprovalOption, ApprovalState, ChatMessage } from "./message";

/**
 * Entities layer — what choosing a permission option actually does.
 *
 * A plan approval is not an ordinary allow/deny: its options SWITCH THE
 * SESSION MODE for everything that follows, and the agent labels them with
 * two or three words ("Auto", "Accept edits"). Those labels look
 * interchangeable, so this attaches the consequence to each one.
 *
 * Keyed by option id rather than name: ids are protocol, names are copy the
 * agent is free to reword between releases.
 */

/** Mode-switch options an agent offers when presenting a plan. */
const MODE_SWITCH_HINTS: Record<string, string> = {
  auto: "Claude runs what it judges safe and stops to ask before anything risky.",
  acceptEdits: "File edits apply without asking. Commands still ask.",
  default: "Approve every edit and every command yourself.",
  bypassPermissions: "Nothing will ask for approval.",
  plan: "Don't start coding — keep working on the plan.",
};

/**
 * One line explaining where an option leaves the session, or `undefined`
 * for the ordinary allow/deny options, which already say what they do.
 */
export function permissionOptionHint(optionId: string): string | undefined {
  return MODE_SWITCH_HINTS[optionId];
}

/**
 * The option that declines a plan — Claude's "keep planning" arrives as a
 * reject kind, so the kind is what to trust; the names are the agent's
 * own copy and change between releases.
 */
export function declineOption(
  options: readonly ApprovalOption[],
): ApprovalOption | undefined {
  return options.find((option) => option.kind.startsWith("reject"));
}

/** True for the choice that means "no, don't start on this". */
export function isDecline(options: readonly ApprovalOption[], optionId: string): boolean {
  return options.some((o) => o.optionId === optionId && o.kind.startsWith("reject"));
}

/**
 * The plan the agent is waiting on, if any. A plan approval parks the
 * turn, so this is what tells the rest of the app that the agent has
 * stopped and is holding for instructions.
 */
export function pendingPlanApproval(
  messages: readonly ChatMessage[],
): ApprovalState | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const approval = messages[i].approval;
    if (!approval?.isPlan) continue;
    if (approval.resolvedOptionId || approval.cancelled) continue;
    return approval;
  }
  return undefined;
}
