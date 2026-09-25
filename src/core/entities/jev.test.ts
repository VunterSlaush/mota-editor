import { describe, expect, it } from "vitest";
import { availablePermissions, effectivePermission } from "./agentSettings";
import {
  defaultJevSettings,
  describeRiskVerdict,
  describeTurnVerdict,
  type JevAnswers,
  judgeQuestions,
  MAX_JUDGE_ANSWER_CHARS,
  MAX_JUDGE_TOOL_TITLES,
  turnJudgeInput,
  turnVerdictFromAnswers,
  verdictNeedsAttention,
} from "./jev";
import { assistantMessage, toolMessage, userMessage } from "./message";

const ON = { enabled: true, gate: true, judge: true };
const GATE_OFF = { ...ON, gate: false };
const ALL_OFF = { ...ON, enabled: false };

describe("Jev permissions", () => {
  it("offers Auto with Jev only while the gate runs", () => {
    const ids = (jev: typeof ON) => availablePermissions(jev).map((p) => p.id);
    expect(ids(ON)).toContain("jev-auto");
    expect(ids(GATE_OFF)).not.toContain("jev-auto");
    expect(ids(ALL_OFF)).not.toContain("jev-auto");
    expect(ids(defaultJevSettings)).not.toContain("jev-auto");
  });

  it("runs jev-auto as manual when the gate is off, never as auto", () => {
    expect(effectivePermission("jev-auto", ON)).toBe("jev-auto");
    expect(effectivePermission("jev-auto", GATE_OFF)).toBe("manual");
    expect(effectivePermission("jev-auto", ALL_OFF)).toBe("manual");
  });

  it("leaves every other permission as it is", () => {
    expect(effectivePermission("bypass", ALL_OFF)).toBe("bypass");
    expect(effectivePermission("auto", GATE_OFF)).toBe("auto");
  });
});

describe("turnJudgeInput", () => {
  const prompt = userMessage("fix the login bug");

  it("reads the rows after the prompt, up to the next one", () => {
    const messages = [
      userMessage("earlier"),
      assistantMessage("earlier answer"),
      prompt,
      toolMessage("execute", "npm test"),
      assistantMessage("Fixed it."),
      assistantMessage("Tests pass."),
      userMessage("next prompt"),
      assistantMessage("not this turn"),
    ];
    const input = turnJudgeInput(messages, prompt.id, "end_turn");
    expect(input).toEqual({
      prompt: "fix the login bug",
      answer: "Fixed it.\n\nTests pass.",
      toolCalls: ["npm test"],
      toolCallCount: 1,
      stopReason: "end_turn",
    });
  });

  it("keeps the tail of a long answer", () => {
    const long = `${"a".repeat(MAX_JUDGE_ANSWER_CHARS)}THE END`;
    const input = turnJudgeInput([prompt, assistantMessage(long)], prompt.id, undefined);
    expect(input?.answer).toHaveLength(MAX_JUDGE_ANSWER_CHARS);
    expect(input?.answer.endsWith("THE END")).toBe(true);
  });

  it("caps the tool titles but counts every call", () => {
    const tools = Array.from({ length: 25 }, (_, i) => toolMessage("read", `file ${i}`));
    const input = turnJudgeInput([prompt, ...tools], prompt.id, undefined);
    expect(input?.toolCalls).toHaveLength(MAX_JUDGE_TOOL_TITLES);
    expect(input?.toolCallCount).toBe(25);
  });

  it("is null once the prompt is gone", () => {
    expect(turnJudgeInput([assistantMessage("x")], "missing", undefined)).toBeNull();
  });
});

describe("judgeQuestions", () => {
  it("asks three yes/no questions", () => {
    const questions = judgeQuestions();
    expect(Object.keys(questions).sort()).toEqual([
      "completed",
      "needs_follow_up",
      "unverified_claim",
    ]);
    for (const question of Object.values(questions)) {
      expect(question.type).toBe("noul");
      expect(question.instructions.length).toBeGreaterThan(0);
    }
  });
});

describe("turnVerdictFromAnswers", () => {
  const noul = (p: number) => ({ type: "noul" as const, noul: p });
  const answers = (entries: JevAnswers["answers"]): JevAnswers => ({
    model: "jev-1.13.0",
    answers: entries,
    usage: { inputTokens: 1, outputTokens: 1 },
  });

  it("maps all three answers", () => {
    const verdict = turnVerdictFromAnswers(
      answers({
        completed: noul(0.9),
        unverified_claim: noul(0.2),
        needs_follow_up: noul(0.1),
      }),
    );
    expect(verdict).toEqual({ completed: 0.9, unverifiedClaim: 0.2, needsFollowUp: 0.1 });
  });

  it("is null when an answer is missing", () => {
    expect(
      turnVerdictFromAnswers(
        answers({ completed: noul(0.9), unverified_claim: noul(0.2) }),
      ),
    ).toBeNull();
  });
});

describe("describing verdicts", () => {
  it("names the risk Jev saw", () => {
    expect(describeRiskVerdict({ risk: 0.91, reason: "destructive" })).toBe(
      "Jev: 91% likely destructive",
    );
    expect(describeRiskVerdict({ risk: 0.3, reason: "unsure" })).toBe(
      "Jev: not clearly safe (30% risk)",
    );
  });

  it("calls a finished, verified turn fine", () => {
    const verdict = { completed: 0.95, unverifiedClaim: 0.1, needsFollowUp: 0.1 };
    expect(verdictNeedsAttention(verdict)).toBe(false);
    expect(describeTurnVerdict(verdict)).toMatchObject({ tone: "ok" });
  });

  it("leads with an unfinished turn over the other concerns", () => {
    const verdict = { completed: 0.2, unverifiedClaim: 0.8, needsFollowUp: 0.8 };
    expect(verdictNeedsAttention(verdict)).toBe(true);
    expect(describeTurnVerdict(verdict)).toMatchObject({
      tone: "warn",
      label: "Jev: may be incomplete",
    });
  });

  it("flags an unverified success claim", () => {
    const verdict = { completed: 0.9, unverifiedClaim: 0.7, needsFollowUp: 0.1 };
    expect(describeTurnVerdict(verdict).label).toBe("Jev: success not verified");
  });

  it("lists all three readings in the detail", () => {
    const detail = describeTurnVerdict({
      completed: 0.9,
      unverifiedClaim: 0.1,
      needsFollowUp: 0.2,
    }).detail;
    expect(detail).toContain("90%");
    expect(detail).toContain("10%");
    expect(detail).toContain("20%");
  });
});
