import { describe, expect, it } from "vitest";
import type { CommandOptimization } from "./commandOptimization";
import {
  activeOptimization,
  commandRunEvidence,
  formatRunEvidence,
  isStale,
  optimizedPrompt,
  parseOptimizationVerdict,
  parseRewriteVerdict,
} from "./commandOptimization";
import type { SessionStats, TurnStat } from "./insights";

const ACTIVE: CommandOptimization = {
  status: "active",
  script: 'npm run typecheck && git commit -m "{{commit_message}}" && git push',
  summary: "Typecheck, commit, push",
  sourceHash: "abc123",
  activatedAt: 1_000,
};

describe("optimization verdict parsing", () => {
  it("reads an optimizable verdict out of the fenced block", () => {
    const reply = [
      "Here is my analysis.",
      "```json",
      '{ "optimizable": true, "script": "git push", "summary": "Push" }',
      "```",
    ].join("\n");
    expect(parseOptimizationVerdict(reply)).toEqual({
      kind: "proposal",
      proposal: { optimizable: true, script: "git push", summary: "Push" },
    });
  });

  it("reads a declined verdict with its reason", () => {
    const reply = '{ "optimizable": false, "reason": "Needs judgment" }';
    expect(parseOptimizationVerdict(reply)).toEqual({
      kind: "proposal",
      proposal: { optimizable: false, reason: "Needs judgment" },
    });
  });

  it("keeps a declined verdict's blockers, each with a way out", () => {
    const reply = JSON.stringify({
      optimizable: false,
      reason: "Two steps need judgment",
      blockers: [
        { quote: "write release notes", advice: "Split into its own command." },
        { quote: "pick a reviewer", advice: "Replace with a {{reviewer}} placeholder." },
      ],
    });
    const verdict = parseOptimizationVerdict(reply);
    expect(verdict).toEqual({
      kind: "proposal",
      proposal: {
        optimizable: false,
        reason: "Two steps need judgment",
        blockers: [
          { quote: "write release notes", advice: "Split into its own command." },
          {
            quote: "pick a reviewer",
            advice: "Replace with a {{reviewer}} placeholder.",
          },
        ],
      },
    });
  });

  it("drops malformed blockers without failing the verdict", () => {
    const reply = JSON.stringify({
      optimizable: false,
      reason: "Needs judgment",
      blockers: ["not an object", { quote: "", advice: "empty quote" }, { quote: "x" }],
    });
    expect(parseOptimizationVerdict(reply)).toEqual({
      kind: "proposal",
      proposal: { optimizable: false, reason: "Needs judgment" },
    });
  });

  it("keeps a hybrid verdict's residual instructions", () => {
    const reply = JSON.stringify({
      optimizable: true,
      script: "gh pr create --title '{{title}}' --body-file /tmp/pr-body.md",
      instructions:
        "Write a PR description from the staged diff into /tmp/pr-body.md, then run the script.",
      summary: "Describe and open a PR",
    });
    const verdict = parseOptimizationVerdict(reply);
    expect(verdict.kind).toBe("proposal");
    if (verdict.kind === "proposal" && verdict.proposal.optimizable) {
      expect(verdict.proposal.instructions).toContain("Write a PR description");
    }
  });

  it("treats blank instructions as a script-only verdict", () => {
    const reply = JSON.stringify({
      optimizable: true,
      script: "git push",
      instructions: "  ",
    });
    expect(parseOptimizationVerdict(reply)).toEqual({
      kind: "proposal",
      proposal: { optimizable: true, script: "git push" },
    });
  });

  it("rejects a reply with no JSON in it", () => {
    const verdict = parseOptimizationVerdict("I could not analyze this command.");
    expect(verdict.kind).toBe("invalid");
  });

  it("rejects an optimizable verdict that forgot the script", () => {
    const verdict = parseOptimizationVerdict('{ "optimizable": true }');
    expect(verdict).toEqual({
      kind: "invalid",
      error: "An optimizable verdict must carry a script.",
    });
  });

  it("rejects a declined verdict that forgot the reason", () => {
    const verdict = parseOptimizationVerdict('{ "optimizable": false }');
    expect(verdict.kind).toBe("invalid");
  });

  it("rejects an implausibly large script", () => {
    const script = "x".repeat(70_000);
    const verdict = parseOptimizationVerdict(
      JSON.stringify({ optimizable: true, script }),
    );
    expect(verdict.kind).toBe("invalid");
  });

  it("skips a fence that is not JSON and finds the one that is", () => {
    const reply = [
      "```sh",
      "echo not the verdict",
      "```",
      "```json",
      '{ "optimizable": true, "script": "echo ok" }',
      "```",
    ].join("\n");
    const verdict = parseOptimizationVerdict(reply);
    expect(verdict.kind).toBe("proposal");
  });
});

describe("rewrite verdict parsing", () => {
  it("reads the rewritten command, script and residual instructions", () => {
    const reply = [
      "```json",
      JSON.stringify({
        command: "---\ndescription: Preview (optimized)\n---\nPost /preview.",
        script: "gh pr comment {{pr_number}} --body /preview",
        instructions: "Derive {{pr_number}} from the arguments.",
        summary: "Deterministic preview",
      }),
      "```",
    ].join("\n");
    const verdict = parseRewriteVerdict(reply);
    expect(verdict.kind).toBe("proposal");
    if (verdict.kind === "proposal") {
      expect(verdict.proposal.command).toContain("Post /preview.");
      expect(verdict.proposal.script).toContain("gh pr comment");
      expect(verdict.proposal.instructions).toContain("{{pr_number}}");
    }
  });

  it("requires both the command text and the script", () => {
    expect(parseRewriteVerdict('{ "command": "text only" }').kind).toBe("invalid");
    expect(parseRewriteVerdict('{ "script": "git push" }').kind).toBe("invalid");
    expect(parseRewriteVerdict("no json here").kind).toBe("invalid");
  });
});

describe("active optimization lookup", () => {
  const map = {
    "claude:/commit-push": ACTIVE,
    "claude:/mota-review": {
      status: "notOptimizable",
      reason: "Judgment-heavy",
      sourceHash: "def",
    },
  } as const;

  it("finds the approved script for its own provider only", () => {
    expect(activeOptimization(map, "claude", "/commit-push")).toBe(ACTIVE);
    expect(activeOptimization(map, "codex", "/commit-push")).toBeUndefined();
  });

  it("never activates a declined or unknown command", () => {
    expect(activeOptimization(map, "claude", "/mota-review")).toBeUndefined();
    expect(activeOptimization(map, "claude", "/unknown")).toBeUndefined();
  });
});

describe("optimized prompt rewrite", () => {
  it("inlines the script and demands a single shell call", () => {
    const prompt = optimizedPrompt("/commit-push", "/commit-push", ACTIVE);
    expect(prompt).toContain(ACTIVE.script);
    expect(prompt).toContain("single shell tool call");
    expect(prompt).not.toContain("Arguments:");
  });

  it("passes the text after the command through as arguments", () => {
    const prompt = optimizedPrompt(
      "/commit-push",
      "  /commit-push mention the gauge fix  ",
      ACTIVE,
    );
    expect(prompt).toContain("Arguments: mention the gauge fix");
  });

  it("weaves residual instructions around the script for hybrid commands", () => {
    const hybrid = {
      ...ACTIVE,
      instructions: "Write the release notes first, then run the script.",
    };
    const prompt = optimizedPrompt("/commit-push", "/commit-push", hybrid);
    expect(prompt).toContain("Instructions:");
    expect(prompt).toContain("Write the release notes first");
    expect(prompt).toContain(ACTIVE.script);
    expect(prompt).toContain("single shell tool call");
    // Script-only rewrites say nothing about instructions.
    expect(optimizedPrompt("/commit-push", "/commit-push", ACTIVE)).not.toContain(
      "Instructions:",
    );
  });

  it("asks for placeholder substitution only when the script has holes", () => {
    expect(optimizedPrompt("/commit-push", "/commit-push", ACTIVE)).toContain(
      "{{placeholder}}",
    );
    const plain = { ...ACTIVE, script: "git push" };
    expect(optimizedPrompt("/commit-push", "/commit-push", plain)).not.toContain(
      "{{placeholder}}",
    );
  });
});

describe("run evidence", () => {
  const turn = (overrides: Partial<TurnStat>): TurnStat => ({
    sentAt: 1_000,
    mode: "normal",
    permission: "default",
    toolCounts: {},
    ...overrides,
  });
  const session = (turns: TurnStat[], provider = "claude"): SessionStats => ({
    sessionId: "s1",
    title: "t",
    projectDirHash: "h",
    provider,
    savedAt: 2_000,
    turns,
    touchedFiles: {},
  });

  it("aggregates runs, averages, and per-run tool calls", () => {
    const sessions = [
      session([
        turn({
          command: "/start-preview",
          tokens: 40_000,
          durationMs: 90_000,
          toolCounts: { execute: 6, read: 4 },
        }),
        turn({
          command: "/start-preview",
          tokens: 20_000,
          durationMs: 30_000,
          toolCounts: { execute: 4 },
        }),
        turn({ command: "/other", tokens: 999_999 }),
      ]),
    ];
    const evidence = commandRunEvidence(sessions, "claude", "/start-preview");
    expect(evidence).toEqual({
      runs: 2,
      avgTokens: 30_000,
      avgDurationMs: 60_000,
      toolCallsPerRun: { execute: 5, read: 2 },
    });
    expect(formatRunEvidence(evidence)).toBe(
      "2 recorded runs, ~30k tokens per run, ~60s per run; tool calls per run: execute x5, read x2.",
    );
  });

  it("returns null when the command never ran", () => {
    expect(commandRunEvidence([session([])], "claude", "/x")).toBeNull();
    expect(formatRunEvidence(null)).toBeNull();
  });

  it("ignores other providers' runs", () => {
    const sessions = [session([turn({ command: "/x", tokens: 5 })], "codex")];
    expect(commandRunEvidence(sessions, "claude", "/x")).toBeNull();
  });
});

describe("staleness", () => {
  it("flags the record once the markdown hash moves", () => {
    expect(isStale(ACTIVE, "abc123")).toBe(false);
    expect(isStale(ACTIVE, "changed")).toBe(true);
  });

  it("stays quiet when the current hash is unknown", () => {
    expect(isStale(ACTIVE, undefined)).toBe(false);
  });
});
