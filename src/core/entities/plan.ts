/**
 * Entities layer — one step of the agent's current plan.
 */
export interface PlanEntry {
  readonly content: string;
  /** high | medium | low */
  readonly priority: string;
  /** pending | in_progress | completed */
  readonly status: string;
}

/**
 * The plan's display name: the step being worked on right now, or the
 * next pending one, or the first step of an all-done plan.
 */
export function planTitle(plan: readonly PlanEntry[]): string {
  const current =
    plan.find((e) => e.status === "in_progress") ??
    plan.find((e) => e.status === "pending") ??
    plan[0];
  return current?.content ?? "Plan";
}

/** The full plan as a Markdown task list. */
export function planToMarkdown(plan: readonly PlanEntry[]): string {
  const lines = plan.map((entry) => {
    const box = entry.status === "completed" ? "[x]" : "[ ]";
    const marker = entry.status === "in_progress" ? " ⟵ in progress" : "";
    const priority = entry.priority === "high" ? " **(high)**" : "";
    return `- ${box} ${entry.content}${priority}${marker}`;
  });
  return ["# Plan", "", ...lines, ""].join("\n");
}
