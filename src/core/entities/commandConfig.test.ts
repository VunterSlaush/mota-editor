import { describe, expect, it } from "vitest";
import { commandConfigKey, isEmptyCommandConfig, leadingCommand } from "./commandConfig";

describe("command config entity", () => {
  it("reads the command a prompt invokes, arguments and all", () => {
    expect(leadingCommand("/review")).toBe("/review");
    expect(leadingCommand("  /review the diff  ")).toBe("/review");
  });

  it("ignores a command that is only mentioned, not invoked", () => {
    expect(leadingCommand("what does /review do?")).toBeNull();
    expect(leadingCommand("fix the bug")).toBeNull();
    expect(leadingCommand("/")).toBeNull();
    expect(leadingCommand("")).toBeNull();
  });

  it("keys the same command name separately per provider", () => {
    expect(commandConfigKey("claude", "/review")).not.toBe(
      commandConfigKey("codex", "/review"),
    );
  });

  it("treats a config that changes nothing as absent", () => {
    expect(isEmptyCommandConfig(undefined)).toBe(true);
    expect(isEmptyCommandConfig({})).toBe(true);
    expect(isEmptyCommandConfig({ mode: "plan" })).toBe(false);
    expect(isEmptyCommandConfig({ effort: "high" })).toBe(false);
  });
});
