import { describe, expect, it } from "vitest";
import type { ChatMessage } from "./message";
import { estimateTokens, formatTokens } from "./tokens";

describe("formatTokens", () => {
  it("shows small counts verbatim", () => {
    expect(formatTokens(742)).toBe("742");
  });

  it("shows thousands as k", () => {
    expect(formatTokens(12_400)).toBe("12k");
    expect(formatTokens(200_000)).toBe("200k");
  });

  it("shows millions as M, not a thousand k", () => {
    expect(formatTokens(1_000_000)).toBe("1M");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});

describe("estimateTokens", () => {
  const message = (text: string): ChatMessage => ({ id: "m1", role: "user", text });

  it("counts ~4 characters per token plus per-message overhead", () => {
    expect(estimateTokens([message("a".repeat(400))])).toBe(104);
  });

  it("is zero for an empty conversation", () => {
    expect(estimateTokens([])).toBe(0);
  });
});
