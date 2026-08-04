import { describe, expect, it } from "vitest";
import { type PlanEntry, planTitle, planToMarkdown } from "./plan";

const plan: PlanEntry[] = [
  { content: "Read the code", priority: "medium", status: "completed" },
  { content: "Add the port", priority: "high", status: "in_progress" },
  { content: "Wire the adapter", priority: "medium", status: "pending" },
];

describe("plan entity", () => {
  it("titles the plan by the step in progress", () => {
    expect(planTitle(plan)).toBe("Add the port");
  });

  it("falls back to the next pending step, then the first", () => {
    expect(planTitle(plan.filter((e) => e.status !== "in_progress"))).toBe(
      "Wire the adapter",
    );
    expect(planTitle([plan[0]])).toBe("Read the code");
    expect(planTitle([])).toBe("Plan");
  });

  it("renders a markdown task list with statuses and priorities", () => {
    const markdown = planToMarkdown(plan);
    expect(markdown).toContain("# Plan");
    expect(markdown).toContain("- [x] Read the code");
    expect(markdown).toContain("- [ ] Add the port **(high)** ⟵ in progress");
    expect(markdown).toContain("- [ ] Wire the adapter");
  });
});
