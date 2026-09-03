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
 * agent is free to reword between releases. But the ids are each AGENT'S
 * protocol, not ACP's — every agent brings its own vocabulary, and they
 * coexist in one table only because they do not collide. They also move:
 * claude-agent-acp 0.73 renamed the whole set (`auto` → `exit-plan-auto`),
 * and because an unknown id renders no hint rather than failing, the plan
 * card went silent instead of going red. Both spellings stay so an older
 * globally-installed adapter keeps its hints.
 */

/** Where approving a plan leaves the session, once the agent is in that mode. */
const LANDS_IN = {
  auto: "Claude runs what it judges safe and stops to ask before anything risky.",
  acceptEdits: "File edits apply without asking. Commands still ask.",
  manual: "Approve every edit and every command yourself.",
  bypass: "Nothing will ask for approval.",
} as const;

/**
 * Claude's "clear context" variants restart from the plan alone. Losing
 * the conversation is the larger of the two consequences and the one the
 * button's own wording buries, so it is said first.
 */
const CLEARS_CONTEXT = "Drops this conversation and restarts from the plan alone.";

/** Mode-switch options an agent offers when presenting a plan. */
const MODE_SWITCH_HINTS: Record<string, string> = {
  // Claude — claude-agent-acp 0.73 and later. It offers exactly one
  // elevated mode, picking auto over bypass over accept-edits, so most
  // sessions only ever see the auto pair.
  "exit-plan-auto": LANDS_IN.auto,
  "exit-plan-accept-edits": LANDS_IN.acceptEdits,
  "exit-plan-bypass": LANDS_IN.bypass,
  "exit-plan-default": LANDS_IN.manual,
  "exit-plan-clear-auto": `${CLEARS_CONTEXT} ${LANDS_IN.auto}`,
  "exit-plan-clear-accept-edits": `${CLEARS_CONTEXT} ${LANDS_IN.acceptEdits}`,
  "exit-plan-clear-bypass": `${CLEARS_CONTEXT} ${LANDS_IN.bypass}`,

  // Claude — adapters before 0.73. Its keep-planning option is now spelled
  // `reject`, which ordinary tool approvals share, so it is deliberately
  // absent below: "No, keep planning" already says what it does.
  auto: LANDS_IN.auto,
  acceptEdits: LANDS_IN.acceptEdits,
  bypassPermissions: LANDS_IN.bypass,
  default: LANDS_IN.manual,
  plan: "Don't start coding — keep working on the plan.",

  // Codex — codex-acp offers no elevated mode at all, only in or out of
  // plan mode, so what needs saying is which permissions it implements under.
  implement_plan:
    "Codex leaves plan mode and starts on the plan with this tab's permissions.",
  revise_plan: "Codex stays in plan mode and waits for what you want changed.",
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
