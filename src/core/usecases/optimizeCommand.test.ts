import { describe, expect, it } from "vitest";
import type { SessionStats } from "../entities/insights";
import type {
  CommandOptimizer,
  OptimizeRun,
  SavedCommandCopy,
} from "../ports/commandOptimizer";
import type { TranscriptStore } from "../ports/transcriptStore";
import { Store } from "../state/store";
import { OptimizeCommand } from "./optimizeCommand";

class FakeOptimizer implements CommandOptimizer {
  saved: Array<{ sourceName: string; content: string }> = [];
  evidenceSeen: Array<string | undefined> = [];

  constructor(private readonly outcome: OptimizeRun | Error) {}

  async optimize(
    _projectPath: string,
    _provider: string,
    _commandName: string,
    evidence?: string,
  ): Promise<OptimizeRun> {
    this.evidenceSeen.push(evidence);
    if (this.outcome instanceof Error) throw this.outcome;
    return this.outcome;
  }

  async rewrite(
    projectPath: string,
    provider: string,
    commandName: string,
    _blockers: unknown,
    evidence?: string,
  ): Promise<OptimizeRun> {
    return this.optimize(projectPath, provider, commandName, evidence);
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

/** Only `listStats` is consulted; history is read, never written, here. */
class FakeTranscriptStats {
  constructor(private readonly stats: SessionStats[] = []) {}
  async listStats(): Promise<SessionStats[]> {
    return this.stats;
  }
}

function useCaseWith(
  optimizer: FakeOptimizer,
  stats: SessionStats[] = [],
): OptimizeCommand {
  return new OptimizeCommand(
    optimizer,
    new Store(),
    new FakeTranscriptStats(stats) as unknown as TranscriptStore,
  );
}

describe("OptimizeCommand", () => {
  it("returns a reviewable proposal with the analyzed hash", async () => {
    const useCase = useCaseWith(
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
    const useCase = useCaseWith(
      new FakeOptimizer({
        text: '{ "optimizable": false, "reason": "Needs judgment" }',
        contentHash: "abc123",
      }),
    );
    const outcome = await useCase.execute("/work", "claude", "/mota-review");
    expect(outcome.kind).toBe("proposal");
  });

  it("turns an unparseable reply into a row-friendly failure", async () => {
    const useCase = useCaseWith(
      new FakeOptimizer({ text: "I refuse to answer in JSON.", contentHash: "abc" }),
    );
    const outcome = await useCase.execute("/work", "claude", "/commit-push");
    expect(outcome.kind).toBe("failed");
  });

  it("parses a rewrite into a copy proposal", async () => {
    const useCase = useCaseWith(
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
    const useCase = useCaseWith(optimizer);
    const saved = await useCase.saveCopy("/work", "claude", "/start-preview", "body");
    expect(saved).toEqual({ name: "/start-preview-optimized", contentHash: "copyhash" });
    expect(optimizer.saved).toEqual([{ sourceName: "/start-preview", content: "body" }]);
  });

  it("folds recorded run history into the analysis as evidence", async () => {
    const optimizer = new FakeOptimizer({
      text: '{ "optimizable": true, "script": "git push" }',
      contentHash: "abc",
    });
    const stats: SessionStats[] = [
      {
        sessionId: "s1",
        title: "t",
        projectDirHash: "h",
        provider: "claude",
        savedAt: 2_000,
        touchedFiles: {},
        turns: [
          {
            sentAt: 1_000,
            mode: "normal",
            permission: "default",
            command: "/commit-push",
            tokens: 12_000,
            toolCounts: { execute: 3 },
          },
        ],
      },
    ];
    await useCaseWith(optimizer, stats).execute("/work", "claude", "/commit-push");
    expect(optimizer.evidenceSeen[0]).toContain("1 recorded run");
    expect(optimizer.evidenceSeen[0]).toContain("execute x3");
  });

  it("optimizes without evidence when history cannot be read", async () => {
    const optimizer = new FakeOptimizer({
      text: '{ "optimizable": true, "script": "git push" }',
      contentHash: "abc",
    });
    const broken = {
      listStats: async () => {
        throw new Error("disk gone");
      },
    } as unknown as TranscriptStore;
    const useCase = new OptimizeCommand(optimizer, new Store(), broken);
    const outcome = await useCase.execute("/work", "claude", "/commit-push");
    expect(outcome.kind).toBe("proposal");
    expect(optimizer.evidenceSeen[0]).toBeUndefined();
  });

  it("turns a failed run into a row-friendly failure", async () => {
    const useCase = useCaseWith(
      new FakeOptimizer(new Error("The `claude` CLI was not found on your PATH.")),
    );
    const outcome = await useCase.execute("/work", "claude", "/commit-push");
    expect(outcome).toEqual({
      kind: "failed",
      error: "Error: The `claude` CLI was not found on your PATH.",
    });
  });
});
