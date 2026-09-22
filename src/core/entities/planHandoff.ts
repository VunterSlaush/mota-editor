/**
 * Entities layer — the prompt that hands an approved plan to a fresh
 * session, possibly on another vendor's model.
 *
 * A plan is the one artifact that survives a handoff intact: it was
 * written to be self-contained, so the agent executing it needs none of
 * the conversation that produced it. What it does need is to be told that
 * the planning is OVER — handed a plan with no context, an agent's first
 * instinct is to plan it again, or to ask which step to start with.
 *
 * Ships INSIDE the app: this text is Mota's, not the user's, and never
 * reaches an agent as a slash command.
 */

const EXECUTE_PLAN_TEMPLATE = `Execute the plan below.

Another agent wrote it in a previous session and the user has approved it for implementation. Do not re-plan it, do not ask which step to start with, and do not summarise it back — the planning is over and this session is the implementation.

Read the files the plan names before you change them; you do not have the conversation the plan came out of, so the repository is your only context. Carry out every step in order. If a step turns out to be wrong or impossible, say so and stop rather than quietly substituting your own approach.

---

__PLAN__`;

/**
 * The brief for the executing session, or `""` when the agent gave no
 * plan text — an instruction to "execute the plan below" with no plan
 * below is worse than not starting at all, so the caller refuses instead.
 */
export function executePlanPrompt(planMarkdown: string): string {
  const plan = planMarkdown.trim();
  if (plan.length === 0) return "";
  return EXECUTE_PLAN_TEMPLATE.replace("__PLAN__", plan);
}
