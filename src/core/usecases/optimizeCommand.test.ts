import { describe, expect, it } from "vitest";
import type { CommandOptimizer, OptimizeRun } from "../ports/commandOptimizer";
import { OptimizeCommand } from "./optimizeCommand";

class FakeOptimizer implements CommandOptimizer {
  constructor(private readonly outcome: OptimizeRun | Error) {}

  async optimize(): Promise<OptimizeRun> {
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }
}

describe("OptimizeCommand", () => {
  it("returns a reviewable proposal with the analyzed hash", async () => {
    const useCase = new OptimizeCommand(
      new FakeOptimizer({
        text: '```json\n{ "optimizable": true, "script": "git push" }\n```',
        contentHash: "abc123",
      }),
    );
    expect(await useCase.execute("/work", "claude", "/commit-push")).toEqual({
      kind: "proposal",
      proposal: { optimizable: true, script: "git push" },
      sourceHash: "abc123",
    });
  });

  it("passes a declined verdict through as a proposal too", async () => {
    const useCase = new OptimizeCommand(
      new FakeOptimizer({
        text: '{ "optimizable": false, "reason": "Needs judgment" }',
        contentHash: "abc123",
      }),
    );
    const outcome = await useCase.execute("/work", "claude", "/mota-review");
    expect(outcome.kind).toBe("proposal");
  });

  it("turns an unparseable reply into a row-friendly failure", async () => {
    const useCase = new OptimizeCommand(
      new FakeOptimizer({ text: "I refuse to answer in JSON.", contentHash: "abc" }),
    );
    const outcome = await useCase.execute("/work", "claude", "/commit-push");
    expect(outcome.kind).toBe("failed");
  });

  it("turns a failed run into a row-friendly failure", async () => {
    const useCase = new OptimizeCommand(
      new FakeOptimizer(new Error("The `claude` CLI was not found on your PATH.")),
    );
    const outcome = await useCase.execute("/work", "claude", "/commit-push");
    expect(outcome).toEqual({
      kind: "failed",
      error: "Error: The `claude` CLI was not found on your PATH.",
    });
  });
});
