import { describe, expect, it } from "vitest";
import { NO_BILLED_TOKENS } from "./billing";
import { billedCostUsd, blendedRatePerMTok, estimateCostUsd } from "./modelPricing";

describe("blendedRatePerMTok", () => {
  it("resolves claude alias families", () => {
    expect(blendedRatePerMTok("claude", "sonnet")).toBeCloseTo(6);
    expect(blendedRatePerMTok("claude", "opus")).toBeCloseTo(10);
    expect(blendedRatePerMTok("claude", "fable")).toBeCloseTo(20);
    expect(blendedRatePerMTok("claude", "haiku")).toBeCloseTo(2);
  });

  it("matches full model ids by substring", () => {
    expect(blendedRatePerMTok("claude", "claude-sonnet-5")).toBeCloseTo(6);
    expect(blendedRatePerMTok("claude", "claude-opus-5")).toBeCloseTo(10);
    expect(blendedRatePerMTok("codex", "gpt-5.5")).toBeCloseTo(11.25);
    expect(blendedRatePerMTok("gemini", "gemini-3.1-pro-preview")).toBeCloseTo(4.5);
  });

  it("keeps opusplan distinct from opus but at the same rate", () => {
    expect(blendedRatePerMTok("claude", "opusplan")).toBeCloseTo(10);
  });

  it("returns null for unknown models and providers", () => {
    expect(blendedRatePerMTok("claude", "totally-new-model")).toBeNull();
    expect(blendedRatePerMTok("gemini", "gemini-3-flash-preview")).toBeNull();
    expect(blendedRatePerMTok("unknown-provider", "sonnet")).toBeNull();
  });

  it("falls back to the provider default when model is undefined", () => {
    expect(blendedRatePerMTok("claude", undefined)).toBeCloseTo(6);
    expect(blendedRatePerMTok("codex", undefined)).toBeCloseTo(11.25);
    expect(blendedRatePerMTok("unknown-provider", undefined)).toBeNull();
  });
});

describe("estimateCostUsd", () => {
  it("scales linearly per million tokens", () => {
    expect(estimateCostUsd(1_000_000, "claude", "sonnet")).toBeCloseTo(6);
    expect(estimateCostUsd(500_000, "claude", "opus")).toBeCloseTo(5);
  });

  it("is zero for zero tokens", () => {
    expect(estimateCostUsd(0, "claude", "sonnet")).toBe(0);
  });

  it("is null when the rate is unknown", () => {
    expect(estimateCostUsd(1_000_000, "claude", "mystery")).toBeNull();
  });
});

describe("billedCostUsd", () => {
  // Opus lists at $5/M input, $25/M output.
  const million = (patch: Partial<typeof NO_BILLED_TOKENS>) => ({
    ...NO_BILLED_TOKENS,
    ...patch,
  });

  it("charges input and output at their own rates", () => {
    expect(
      billedCostUsd(million({ inputTokens: 1_000_000 }), "claude", "opus"),
    ).toBeCloseTo(5);
    expect(
      billedCostUsd(million({ outputTokens: 1_000_000 }), "claude", "opus"),
    ).toBeCloseTo(25);
  });

  it("charges cache writes above the input rate, by TTL", () => {
    expect(
      billedCostUsd(million({ cacheWrite5mTokens: 1_000_000 }), "claude", "opus"),
    ).toBeCloseTo(6.25); // 5 x 1.25
    expect(
      billedCostUsd(million({ cacheWrite1hTokens: 1_000_000 }), "claude", "opus"),
    ).toBeCloseTo(10); // 5 x 2.0
  });

  it("charges cache reads at a tenth of the input rate", () => {
    expect(
      billedCostUsd(million({ cacheReadTokens: 1_000_000 }), "claude", "opus"),
    ).toBeCloseTo(0.5);
  });

  it("shows why a cache hit is worth twenty times a cache write", () => {
    // The same million tokens, re-read instead of re-written — this gap
    // is what Insights exists to make visible.
    const read = billedCostUsd(million({ cacheReadTokens: 1_000_000 }), "claude", "opus");
    const written = billedCostUsd(
      million({ cacheWrite1hTokens: 1_000_000 }),
      "claude",
      "opus",
    );
    expect(written).toBeCloseTo((read ?? 0) * 20);
  });

  it("sums the buckets", () => {
    const tokens = million({
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
    });
    expect(billedCostUsd(tokens, "claude", "opus")).toBeCloseTo(30.5);
  });

  it("is zero when nothing was billed", () => {
    expect(billedCostUsd(NO_BILLED_TOKENS, "claude", "opus")).toBe(0);
  });

  it("prices the full model ids that appear in vendor logs", () => {
    const tokens = million({ inputTokens: 1_000_000 });
    expect(billedCostUsd(tokens, "claude", "claude-opus-5")).toBeCloseTo(5);
    expect(billedCostUsd(tokens, "claude", "claude-sonnet-5")).toBeCloseTo(3);
    expect(billedCostUsd(tokens, "claude", "claude-haiku-4-5-20251001")).toBeCloseTo(1);
    expect(billedCostUsd(tokens, "claude", "claude-fable-5")).toBeCloseTo(10);
  });

  it("is null when the model has no known price", () => {
    expect(billedCostUsd(NO_BILLED_TOKENS, "claude", "mystery")).toBeNull();
  });
});
