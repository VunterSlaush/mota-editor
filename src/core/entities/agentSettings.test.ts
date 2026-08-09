import { describe, expect, it } from "vitest";
import { COST_PRESETS, matchingCostPreset } from "./agentSettings";
import { EFFORT_OPTIONS, MODEL_SUGGESTIONS, PROVIDERS } from "./provider";

describe("COST_PRESETS", () => {
  it("names a model and effort for every provider", () => {
    // A preset that quietly skips a provider would leave that provider's
    // defaults untouched while the picker claimed otherwise.
    for (const preset of COST_PRESETS) {
      for (const provider of PROVIDERS) {
        expect(preset.model[provider.id]).toBeDefined();
        expect(preset.effort[provider.id]).toBeDefined();
      }
    }
  });

  it("only names models the picker also offers", () => {
    for (const preset of COST_PRESETS) {
      for (const provider of PROVIDERS) {
        expect(MODEL_SUGGESTIONS[provider.id]).toContain(preset.model[provider.id]);
      }
    }
  });

  it("only names efforts the provider actually supports", () => {
    // Gemini exposes no effort control, so its presets must ask for none.
    for (const preset of COST_PRESETS) {
      for (const provider of PROVIDERS) {
        const effort = preset.effort[provider.id];
        if (effort === "") continue;
        expect(EFFORT_OPTIONS[provider.id]).toContain(effort);
      }
    }
  });

  it("orders them cheapest first", () => {
    expect(COST_PRESETS.map((p) => p.id)).toEqual(["economy", "balanced", "max"]);
  });
});

describe("matchingCostPreset", () => {
  it("recognises a pair it set itself", () => {
    for (const preset of COST_PRESETS) {
      expect(
        matchingCostPreset("claude", preset.model.claude, preset.effort.claude),
      ).toBe(preset.id);
    }
  });

  it("is null for a pair the user built by hand", () => {
    // Economy's model at maximum effort is exactly the mismatch presets
    // exist to prevent — it must not be reported as a preset.
    expect(matchingCostPreset("claude", "haiku", "max")).toBeNull();
  });

  it("treats an unset model or effort as the empty string", () => {
    expect(matchingCostPreset("gemini", undefined, undefined)).toBeNull();
    const economy = COST_PRESETS[0];
    expect(matchingCostPreset("gemini", economy.model.gemini, undefined)).toBe("economy");
  });
});
