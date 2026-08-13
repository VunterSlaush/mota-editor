import { describe, expect, it } from "vitest";
import type {
  CommandOptimizer,
  OptimizeRun,
  SavedCommandCopy,
} from "../ports/commandOptimizer";
import { OptimizeCommand } from "./optimizeCommand";

class FakeOptimizer implements CommandOptimizer {
  saved: Array<{ sourceName: string; content: string }> = [];

  constructor(private readonly outcome: OptimizeRun | Error) {}

  async optimize(): Promise<OptimizeRun> {
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }

  async rewrite(): Promise<OptimizeRun> {
    return this.optimize();
  }

  async saveCopy(
    _projectPath: string,
    _provider: string,
    sourceName: string,
    content: string,
  ): Promise<SavedCommandCopy> {
    this.saved.push({ sourceName, content });
    return { name: `${sourceName}-optimized`, contentHash: "copyhash" };
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

  it("parses a rewrite into a copy proposal", async () => {
    const useCase = new OptimizeCommand(
      new FakeOptimizer({
        text: JSON.stringify({
          command: "Post /preview on PR {{pr_number}}.",
          script: "gh pr comment {{pr_number}} --body /preview",
          summary: "Deterministic preview",
        }),
        contentHash: "abc",
      }),
    );
    const outcome = await useCase.rewrite("/work", "claude", "/start-preview", []);
    expect(outcome.kind).toBe("proposal");
    if (outcome.kind === "proposal") {
      expect(outcome.proposal.command).toContain("{{pr_number}}");
    }
  });

  it("writes the approved copy through the port", async () => {
    const optimizer = new FakeOptimizer({ text: "{}", contentHash: "x" });
    const useCase = new OptimizeCommand(optimizer);
    const saved = await useCase.saveCopy("/work", "claude", "/start-preview", "body");
    expect(saved).toEqual({ name: "/start-preview-optimized", contentHash: "copyhash" });
    expect(optimizer.saved).toEqual([{ sourceName: "/start-preview", content: "body" }]);
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
