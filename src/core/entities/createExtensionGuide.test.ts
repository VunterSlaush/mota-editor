import { describe, expect, it } from "vitest";
import { BUILTIN_COMMANDS } from "./command";
import { CREATE_EXTENSION_COMMAND, createExtensionPrompt } from "./createExtensionGuide";

describe("the built-in /create-extension command", () => {
  it("is offered with every provider — any install can create extensions", () => {
    for (const commands of Object.values(BUILTIN_COMMANDS)) {
      expect(commands.map((c) => c.name)).toContain(CREATE_EXTENSION_COMMAND);
    }
  });

  it("folds the user's request into the brief", () => {
    const prompt = createExtensionPrompt("a command that drafts release notes");
    expect(prompt).toContain("What the user wants: a command that drafts release notes");
    expect(prompt).not.toContain("__USER_REQUEST__");
  });

  it("tells the agent to ask when no request was given", () => {
    expect(createExtensionPrompt("")).toContain("ask them");
  });

  it("still teaches the real $ARGUMENTS marker verbatim", () => {
    // The guide's own substitution uses a private slot precisely so the
    // lesson survives; a regression here means generated manifests break.
    expect(createExtensionPrompt("anything")).toContain("$ARGUMENTS");
  });
});
