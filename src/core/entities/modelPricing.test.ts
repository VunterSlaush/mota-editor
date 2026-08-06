import { describe, expect, it } from "vitest";
import { blendedRatePerMTok, estimateCostUsd } from "./modelPricing";

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
