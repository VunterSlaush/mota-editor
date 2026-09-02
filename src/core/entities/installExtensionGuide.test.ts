import { describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS } from "./command";
import { STORE_REGISTRY_URL } from "./extensionStore";
import {
  INSTALL_EXTENSION_COMMAND,
  installExtensionPrompt,
} from "./installExtensionGuide";
import { isNeverDelegated } from "./subagent";

describe("the built-in /install-extension command", () => {
  it("is offered with every provider — any install can reach the store", () => {
    for (const commands of Object.values(BUILTIN_COMMANDS)) {
      expect(commands.map((c) => c.name)).toContain(INSTALL_EXTENSION_COMMAND);
    }
  });

  it("folds what the user named into the brief", () => {
    const prompt = installExtensionPrompt("linear");
    expect(prompt).toContain("What they asked for: linear");
    expect(prompt).not.toContain("__USER_REQUEST__");
  });

  it("asks for the catalogue when nothing was named", () => {
    // The empty-handed case is the one people will type first, and it
    // must browse rather than guess at an id.
    expect(installExtensionPrompt("")).toContain("show them what the store has");
  });

  it("points at the real index", () => {
    expect(installExtensionPrompt("")).toContain(STORE_REGISTRY_URL);
  });

  it("makes consent and the permission list non-optional", () => {
    const prompt = installExtensionPrompt("standup");
    // The three sentences that keep an agent from installing a stranger's
    // code on a shrug. Losing any of them silently is the failure that
    // matters here, not a broken manifest.
    expect(prompt).toContain("Only after they say yes");
    expect(prompt).toContain("SPENDS THE USER'S AI CREDITS");
    expect(prompt).toContain("You cannot enable it yourself");
  });

  it("is never delegated to a sub-agent — a child cannot be asked for consent", () => {
    expect(isNeverDelegated("claude", INSTALL_EXTENSION_COMMAND)).toBe(true);
  });
});
