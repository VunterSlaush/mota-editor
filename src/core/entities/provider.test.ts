import { describe, expect, it } from "vitest";
import {
  COMPACT_COMMAND,
  contextWindowFor,
  EFFORT_OPTIONS,
  isProvisionalContextSize,
  PROVIDERS,
  providerById,
} from "./provider";

describe("contextWindowFor", () => {
  it("caps haiku at 200k while the rest of the claude line is 1M", () => {
    expect(contextWindowFor("claude", "haiku")).toBe(200_000);
    expect(contextWindowFor("claude", "sonnet")).toBe(1_000_000);
    expect(contextWindowFor("claude", "opus")).toBe(1_000_000);
    expect(contextWindowFor("claude", "fable")).toBe(1_000_000);
    expect(contextWindowFor("claude", "opusplan")).toBe(1_000_000);
  });

  it("matches full model ids by substring, case-insensitively", () => {
    expect(contextWindowFor("claude", "claude-haiku-4-5")).toBe(200_000);
    expect(contextWindowFor("claude", "Haiku")).toBe(200_000);
    expect(contextWindowFor("claude", "claude-sonnet-5")).toBe(1_000_000);
  });

  it("gives the gpt-5 family 400k", () => {
    expect(contextWindowFor("codex", "gpt-5.5")).toBe(400_000);
    expect(contextWindowFor("codex", "gpt-5.4-mini")).toBe(400_000);
    expect(contextWindowFor("codex", "gpt-5.3-codex")).toBe(400_000);
  });

  it("falls back to the provider default for unset or unknown models", () => {
    // "" is the pickers' provider-default sentinel, undefined the unset tab.
    expect(contextWindowFor("claude", undefined)).toBe(1_000_000);
    expect(contextWindowFor("claude", "")).toBe(1_000_000);
    expect(contextWindowFor("codex", "some-future-model")).toBe(400_000);
    expect(contextWindowFor("gemini", "gemini-3.1-pro-preview")).toBe(1_000_000);
  });

  it("agrees with each provider's descriptor on the default model", () => {
    // The descriptor's contextWindow IS the default-model window; the two
    // drifting apart would make the gauge depend on which path built it.
    expect(contextWindowFor("claude", undefined)).toBe(
      providerById("claude").contextWindow,
    );
    expect(contextWindowFor("codex", undefined)).toBe(
      providerById("codex").contextWindow,
    );
    expect(contextWindowFor("gemini", undefined)).toBe(
      providerById("gemini").contextWindow,
    );
  });

  it("gives the gateway-routed agents their conservative floor", () => {
    // Neither knows its window ahead of the first turn — it depends on
    // which account the user authenticated — so the estimate starts low
    // and a real usage_update corrects it upward.
    expect(contextWindowFor("opencode", "opencode/big-pickle")).toBe(200_000);
    expect(contextWindowFor("opencode", undefined)).toBe(200_000);
    expect(contextWindowFor("cline", undefined)).toBe(200_000);
  });
});

describe("PROVIDERS", () => {
  it("offers every provider the type allows, so none is unreachable", () => {
    // The picker is built from this list alone: an id added to the union
    // and forgotten here can be persisted but never chosen.
    expect(PROVIDERS.map((p) => p.id)).toEqual([
      "claude",
      "codex",
      "gemini",
      "opencode",
      "cline",
    ]);
  });

  it("names a compact command and an effort list for every provider", () => {
    for (const provider of PROVIDERS) {
      // An empty compact command would be sent as a blank prompt turn and
      // would mis-classify every turn Insights tried to match against it.
      expect(COMPACT_COMMAND[provider.id]).toMatch(/^\//);
      expect(EFFORT_OPTIONS[provider.id]).toBeDefined();
    }
  });
});

describe("isProvisionalContextSize", () => {
  it("flags the adapter's 200k seed on models whose window is larger", () => {
    expect(isProvisionalContextSize("claude", undefined, 200_000)).toBe(true);
    expect(isProvisionalContextSize("claude", "sonnet", 200_000)).toBe(true);
    expect(isProvisionalContextSize("claude", "fable", 200_000)).toBe(true);
  });

  it("trusts 200k on haiku — that IS its window, not a placeholder", () => {
    expect(isProvisionalContextSize("claude", "haiku", 200_000)).toBe(false);
  });

  it("trusts any size that is not exactly the seed", () => {
    expect(isProvisionalContextSize("claude", "fable", 1_000_000)).toBe(false);
    expect(isProvisionalContextSize("claude", "fable", 195_000)).toBe(false);
  });

  it("never flags other providers — the seed is a Claude adapter quirk", () => {
    expect(isProvisionalContextSize("codex", "gpt-5.5", 200_000)).toBe(false);
    expect(isProvisionalContextSize("gemini", undefined, 200_000)).toBe(false);
    // 200k is these two's stated window, so it is the answer, not a seed.
    expect(isProvisionalContextSize("opencode", undefined, 200_000)).toBe(false);
    expect(isProvisionalContextSize("cline", undefined, 200_000)).toBe(false);
  });
});
