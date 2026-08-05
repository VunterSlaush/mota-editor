import { describe, expect, it } from "vitest";
import { mergeToolCall, toolCallMessage } from "./message";

describe("mergeToolCall", () => {
  const base = toolCallMessage("c1", "execute", "npm test", "pending").toolCall;
  if (!base) throw new Error("toolCallMessage must set toolCall");

  it("keeps fields the update did not send", () => {
    const merged = mergeToolCall(base, { status: "in_progress" });
    expect(merged.status).toBe("in_progress");
    expect(merged.toolCallId).toBe("c1");
    expect(merged.content).toEqual([]);
    expect(merged.locations).toEqual([]);
  });

  it("replaces content and locations when the update carries them", () => {
    const first = mergeToolCall(base, {
      content: [{ type: "text", text: "old output" }],
      locations: [{ path: "a.ts" }],
    });
    const second = mergeToolCall(first, {
      status: "completed",
      content: [{ type: "text", text: "final output" }],
    });
    // Content replaces (ACP sends it cumulatively); locations survive a
    // content-only update untouched.
    expect(second.content).toEqual([{ type: "text", text: "final output" }]);
    expect(second.locations).toEqual([{ path: "a.ts" }]);
    expect(second.status).toBe("completed");
  });

  it("an empty content array does not erase earlier output", () => {
    const withOutput = mergeToolCall(base, {
      content: [{ type: "text", text: "kept" }],
    });
    const updated = mergeToolCall(withOutput, { status: "completed", content: [] });
    expect(updated.content).toEqual([{ type: "text", text: "kept" }]);
  });
});
