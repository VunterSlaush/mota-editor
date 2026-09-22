import { describe, expect, it } from "vitest";
import { executePlanPrompt } from "./planHandoff";

const PLAN = "## Step 1\n\nRename `foo` to `bar` in `src/foo.ts`.";

describe("executePlanPrompt", () => {
  it("carries the plan text through verbatim", () => {
    // The receiving agent has none of the planning conversation, so the
    // plan is the whole brief — a paraphrase would lose the work.
    expect(executePlanPrompt(PLAN)).toContain(PLAN);
  });

  it("tells the agent to execute what it was handed, not to plan it again", () => {
    const prompt = executePlanPrompt(PLAN).toLowerCase();
    expect(prompt).toContain("do not re-plan");
    expect(prompt).toContain("approved");
  });

  it("is empty for a blank plan, so nothing is sent without one", () => {
    expect(executePlanPrompt("")).toBe("");
    expect(executePlanPrompt("   \n  ")).toBe("");
  });
});
