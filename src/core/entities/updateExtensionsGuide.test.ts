import { describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS } from "./command";
import { STORE_REGISTRY_URL } from "./extensionStore";
import { isNeverDelegated } from "./subagent";
import {
  UPDATE_EXTENSIONS_COMMAND,
  updateExtensionsPrompt,
} from "./updateExtensionsGuide";

describe("the built-in /update-extensions command", () => {
  it("is offered with every provider — any install can reach the store", () => {
    for (const commands of Object.values(BUILTIN_COMMANDS)) {
      expect(commands.map((c) => c.name)).toContain(UPDATE_EXTENSIONS_COMMAND);
    }
  });

  it("folds what the user named into the brief", () => {
    const prompt = updateExtensionsPrompt("just the rtk one");
    expect(prompt).toContain("What they asked for: just the rtk one");
    expect(prompt).not.toContain("__USER_REQUEST__");
  });

  it("checks everything installed when nothing was named", () => {
    // What the Settings button sends, and the case that must not turn
    // into "pick one for me".
    expect(updateExtensionsPrompt("")).toContain("check every installed extension");
  });

  it("points at the real index", () => {
    expect(updateExtensionsPrompt("")).toContain(STORE_REGISTRY_URL);
  });

  it("makes consent and the permission diff non-optional", () => {
    const prompt = updateExtensionsPrompt("");
    // An update is somebody else's new code arriving on a version bump —
    // these are the sentences that keep it from arriving unannounced.
    expect(prompt).toContain("Only after they say yes");
    expect(prompt).toContain("SPENDS THE USER'S AI CREDITS");
    expect(prompt).toContain("Needs approval");
    expect(prompt).toContain("You cannot enable or approve anything yourself");
  });

  it("refuses to wipe the installed folder — extensions keep data in it", () => {
    expect(updateExtensionsPrompt("")).toContain("Do NOT delete the folder first");
  });

  it("is never delegated to a sub-agent — a child cannot be asked for consent", () => {
    expect(isNeverDelegated("claude", UPDATE_EXTENSIONS_COMMAND)).toBe(true);
  });
});
