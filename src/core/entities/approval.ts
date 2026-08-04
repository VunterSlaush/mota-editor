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
