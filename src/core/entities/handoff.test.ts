import { describe, expect, it } from "vitest";
import { buildHandoff } from "./handoff";
import {
  assistantMessage,
  errorMessage,
  infoMessage,
  thoughtMessage,
  toolMessage,
  userMessage,
} from "./message";

describe("buildHandoff", () => {
  it("carries the conversation oldest first, labelled by speaker", () => {
    const handoff = buildHandoff([
      userMessage("fix the parser"),
      assistantMessage("done — it was the escape handling"),
    ]);
    expect(handoff).toBe(
      "User: fix the parser\n\nAssistant: done — it was the escape handling",
    );
  });

  it("keeps only what carries intent", () => {
    const handoff = buildHandoff([
      userMessage("fix the parser"),
      thoughtMessage("let me look at the lexer"),
      toolMessage("Read", "800 lines of parser.ts"),
      infoMessage("Agent restarted"),
      errorMessage("something failed"),
      assistantMessage("done"),
    ]);
    expect(handoff).toBe("User: fix the parser\n\nAssistant: done");
  });

  it("prefers the newest messages when the budget is tight", () => {
    // "this" and "we just" always point at the end of a conversation.
    const handoff = buildHandoff(
      [
        userMessage("the oldest thing, long forgotten"),
        userMessage("the middle"),
        assistantMessage("the most recent"),
      ],
      12,
    );
    expect(handoff).toContain("the most recent");
    expect(handoff).not.toContain("long forgotten");
  });

  it("stays inside its budget", () => {
    const many = Array.from({ length: 200 }, (_, i) =>
      userMessage(`message ${i} `.repeat(20)),
    );
    expect(buildHandoff(many, 500).length).toBeLessThan(500 * 4);
  });

  it("returns nothing when there is nothing worth sending", () => {
    expect(buildHandoff([])).toBe("");
    expect(buildHandoff([toolMessage("Bash", "git status")])).toBe("");
    expect(buildHandoff([userMessage("   ")])).toBe("");
  });

  it("returns nothing rather than a fragment when one message alone busts the budget", () => {
    expect(buildHandoff([userMessage("x".repeat(10_000))], 10)).toBe("");
  });
});
