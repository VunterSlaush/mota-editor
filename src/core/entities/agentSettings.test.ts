import { describe, expect, it } from "vitest";
import {
  COST_PRESETS,
  clampAutoCompactThreshold,
  DEFAULT_AUTO_COMPACT_THRESHOLD,
  MAX_AUTO_COMPACT_THRESHOLD,
  MIN_AUTO_COMPACT_THRESHOLD,
  MODES,
  matchingCostPreset,
  modeFromAgentModeId,
} from "./agentSettings";
import { EFFORT_OPTIONS, MODEL_SUGGESTIONS, PROVIDERS } from "./provider";

describe("clampAutoCompactThreshold", () => {
  it("passes a value inside the usable range through untouched", () => {
    expect(clampAutoCompactThreshold(0.6)).toBe(0.6);
    expect(clampAutoCompactThreshold(DEFAULT_AUTO_COMPACT_THRESHOLD)).toBe(
      DEFAULT_AUTO_COMPACT_THRESHOLD,
    );
  });

  it("pulls a corrupt zero up to the floor instead of compacting every turn", () => {
    expect(clampAutoCompactThreshold(0)).toBe(MIN_AUTO_COMPACT_THRESHOLD);
  });

  it("pulls a value above one down to the ceiling instead of never compacting", () => {
    expect(clampAutoCompactThreshold(1.5)).toBe(MAX_AUTO_COMPACT_THRESHOLD);
  });

  it("falls back to the default when the value is not a number at all", () => {
    expect(clampAutoCompactThreshold(Number.NaN)).toBe(DEFAULT_AUTO_COMPACT_THRESHOLD);
  });
});

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

describe("modeFromAgentModeId", () => {
  it("follows the agent when it genuinely changes what it enforces", () => {
    // The everyday case: the agent leaves plan mode after an approved
    // plan, and the composer's picker has to stop saying "Plan".
    expect(modeFromAgentModeId("default", "plan")).toBe("agent");
    expect(modeFromAgentModeId("plan", "agent")).toBe("plan");
    expect(modeFromAgentModeId("read-only", "agent")).toBe("plan");
  });

  it("leaves Ask alone when the agent confirms the read-only session", () => {
    // Ask rides plan mode's enforcement, so the agent reports "plan" for
    // both. Reading that as a mode CHANGE would drag every Ask tab into
    // Plan the moment its session announced itself.
    expect(modeFromAgentModeId("plan", "ask")).toBe("ask");
    expect(modeFromAgentModeId("read-only", "ask")).toBe("ask");
  });

  it("leaves Debug alone when the agent confirms a writable session", () => {
    // Same shape, the other side of the line: Debug is Agent's
    // enforcement with different instructions.
    expect(modeFromAgentModeId("default", "debug")).toBe("debug");
    expect(modeFromAgentModeId("agent", "debug")).toBe("debug");
    expect(modeFromAgentModeId("bypassPermissions", "debug")).toBe("debug");
  });

  it("still moves Ask and Debug when the enforcement really flips", () => {
    expect(modeFromAgentModeId("default", "ask")).toBe("agent");
    expect(modeFromAgentModeId("plan", "debug")).toBe("plan");
  });

  it("is null for an id this build has never heard of", () => {
    // Guessing a mode the user never chose is worse than doing nothing.
    expect(modeFromAgentModeId("architect", "agent")).toBeNull();
  });
});

describe("MODES", () => {
  it("offers every mode the type allows, so none is unreachable", () => {
    // The picker is built from this list alone: a mode added to the
    // union and forgotten here can be persisted but never chosen.
    expect(MODES.map((m) => m.id)).toEqual(["agent", "plan", "ask", "debug"]);
  });
});
