import { describe, expect, it } from "vitest";
import { describePending, pendingCostWarning } from "./pendingSpecText";

describe("describePending", () => {
  it("names the model", () => {
    expect(describePending({ model: "opus" })).toBe("Opus applies");
  });

  it("names the effort", () => {
    expect(describePending({ effort: "high" })).toBe("High effort applies");
  });

  it("names both when both are queued", () => {
    expect(describePending({ model: "opus", effort: "high" })).toBe(
      "Opus and high effort applies",
    );
  });

  it("says 'default' rather than showing an empty value", () => {
    // "" is the pickers' sentinel for the provider default. Rendering it
    // raw would produce " applies", which reads as a bug.
    expect(describePending({ model: "" })).toBe("The default model applies");
    expect(describePending({ effort: "" })).toBe("The default effort applies");
  });
});

describe("pendingCostWarning", () => {
  it("promises a cache-write bill for a model change", () => {
    // The prompt cache is keyed per model, so none of the re-sent
    // context can be read from cache — this one always costs.
    const warning = pendingCostWarning({ model: "opus" }, 50_000);
    expect(warning).toContain("re-sends this conversation");
    expect(warning).toContain("cache-write rates");
    expect(warning).not.toContain("may re-send");
  });

  it("only says an effort change MAY re-send", () => {
    // Effort keeps the same model, so a warm cache can still absorb it.
    // Claiming a bill here would be the dishonesty the bar exists to fix.
    const warning = pendingCostWarning({ effort: "high" }, 50_000);
    expect(warning).toContain("may re-send this conversation");
    expect(warning).not.toContain("cache-write rates");
  });

  it("uses the expensive wording when a model change rides along with effort", () => {
    const warning = pendingCostWarning({ model: "opus", effort: "high" }, 50_000);
    expect(warning).toContain("cache-write rates");
  });

  it("quotes the context size so the cost is a number, not a feeling", () => {
    expect(pendingCostWarning({ model: "opus" }, 50_000)).toContain("(~50k tokens)");
  });

  it("omits the size when the agent is holding nothing yet", () => {
    // A "(~0 tokens)" parenthetical would undercut the warning it sits in.
    for (const tokens of [undefined, 0]) {
      expect(pendingCostWarning({ model: "opus" }, tokens)).not.toContain("~");
    }
  });
});
