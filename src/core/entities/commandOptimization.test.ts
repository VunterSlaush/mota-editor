import { describe, expect, it } from "vitest";
import type { CommandOptimization } from "./commandOptimization";
import {
  activeOptimization,
  isStale,
  optimizedPrompt,
  parseOptimizationVerdict,
} from "./commandOptimization";

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

describe("staleness", () => {
  it("flags the record once the markdown hash moves", () => {
    expect(isStale(ACTIVE, "abc123")).toBe(false);
    expect(isStale(ACTIVE, "changed")).toBe(true);
  });

  it("stays quiet when the current hash is unknown", () => {
    expect(isStale(ACTIVE, undefined)).toBe(false);
  });
});
