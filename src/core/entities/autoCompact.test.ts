import { describe, expect, it } from "vitest";
import { autoCompactDecision, claimsTheTurn } from "./autoCompact";
import { assistantMessage, type ChatMessage, userMessage } from "./message";

const settings = (autoCompact: "compact" | "newChat" | "ask" | "off") => ({
  autoCompact,
  autoCompactThreshold: 0.8,
});

const tab = (
  used: number,
  messages: readonly ChatMessage[] = [],
  contextFullPercent?: number,
) => ({
  messages,
  usage: { used, size: 100 },
  project: { provider: "claude" as const },
  ...(contextFullPercent !== undefined ? { contextFullPercent } : {}),
});

describe("autoCompactDecision", () => {
  it("does nothing for a tab that has reported no usage", () => {
    const noUsage = { messages: [], project: { provider: "claude" as const } };
    expect(autoCompactDecision(noUsage, settings("compact")).action).toBe("nothing");
  });

  it("does nothing while the policy is off, however full the context", () => {
    expect(autoCompactDecision(tab(99), settings("off")).action).toBe("nothing");
  });

  it("does nothing below the threshold", () => {
    expect(autoCompactDecision(tab(50), settings("compact")).action).toBe("nothing");
  });

  it("takes the question down once the context drops back under", () => {
    // A compaction, or a new session: the question no longer stands.
    expect(autoCompactDecision(tab(50, [], 91), settings("compact")).action).toBe(
      "dismiss",
    );
  });

  it("compacts over the threshold, saying how full it got", () => {
    const decision = autoCompactDecision(tab(91), settings("compact"));
    expect(decision).toEqual({ action: "compact", percent: 91, command: "/compact" });
  });

  it("uses the provider's own word for compaction", () => {
    const gemini = { ...tab(91), project: { provider: "gemini" as const } };
    expect(autoCompactDecision(gemini, settings("compact"))).toMatchObject({
      command: "/compress",
    });
  });

  it("hands the choice back under the ask policy", () => {
    expect(autoCompactDecision(tab(91), settings("ask"))).toEqual({
      action: "ask",
      percent: 91,
    });
  });

  it("starts a new chat under the newChat policy", () => {
    expect(autoCompactDecision(tab(91), settings("newChat"))).toEqual({
      action: "newChat",
      percent: 91,
    });
  });

  it("never triggers on the compaction turn itself", () => {
    // Otherwise compacting a conversation that is still over the ceiling
    // would compact it again, and again.
    const justCompacted = tab(91, [
      userMessage("/compact"),
      assistantMessage("Summarized."),
    ]);
    expect(autoCompactDecision(justCompacted, settings("compact")).action).toBe(
      "nothing",
    );
  });
});

describe("claimsTheTurn", () => {
  /**
   * The reason this is a query at all. `SendPrompt` drains its prompt
   * queue when a turn completes — but compacting and starting a new chat
   * both take the tab for themselves, and `execute` suspends at its first
   * await long before `busy` goes up. A drain that could not ask this
   * would start a second, concurrent turn.
   */
  it("is true for the two policies that take the tab for themselves", () => {
    expect(claimsTheTurn({ action: "compact", percent: 91, command: "/compact" })).toBe(
      true,
    );
    expect(claimsTheTurn({ action: "newChat", percent: 91 })).toBe(true);
  });

  it("is false for the ones that only put something on screen", () => {
    expect(claimsTheTurn({ action: "ask", percent: 91 })).toBe(false);
    expect(claimsTheTurn({ action: "dismiss" })).toBe(false);
    expect(claimsTheTurn({ action: "nothing" })).toBe(false);
  });
});
