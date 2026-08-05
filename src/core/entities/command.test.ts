import { describe, expect, it } from "vitest";
import { type CommandInfo, commandNames, filterCommands, splitCommands } from "./command";

const COMMANDS: readonly CommandInfo[] = [
  { name: "/review", description: "Review changes", source: "builtin" },
  { name: "/init", description: "Write CLAUDE.md", source: "builtin" },
  { name: "/start-task", description: "Start from Linear", source: "custom" },
];

const NAMES = commandNames(COMMANDS);

/** The highlight must never alter what the user typed. */
const rejoin = (text: string) =>
  splitCommands(text, NAMES)
    .map((s) => s.text)
    .join("");

describe("filterCommands", () => {
  it("matches on prefix, ignoring case", () => {
    expect(filterCommands(COMMANDS, "/i").map((c) => c.name)).toEqual(["/init"]);
    expect(filterCommands(COMMANDS, "/REV").map((c) => c.name)).toEqual(["/review"]);
    expect(filterCommands(COMMANDS, "/nope")).toEqual([]);
  });
});

describe("splitCommands", () => {
  it("flags a leading command and leaves the rest alone", () => {
    expect(splitCommands("/review the diff", NAMES)).toEqual([
      { text: "/review", command: true },
      { text: " the diff", command: false },
    ]);
  });

  it("flags a command anywhere in the text", () => {
    expect(splitCommands("run /init first", NAMES)).toEqual([
      { text: "run ", command: false },
      { text: "/init", command: true },
      { text: " first", command: false },
    ]);
  });

  it("flags several commands in one prompt", () => {
    const segments = splitCommands("/init then /review", NAMES);
    expect(segments.filter((s) => s.command).map((s) => s.text)).toEqual([
      "/init",
      "/review",
    ]);
  });

  it("ignores slashes that are not commands", () => {
    for (const text of [
      "look in /usr/bin/env for it",
      "https://github.com/o/r/blob/main/a.ts",
      "C:\\work/review",
      "/reviewing",
      "/review,",
    ]) {
      expect(splitCommands(text, NAMES).some((s) => s.command)).toBe(false);
    }
  });

  it("matches case-insensitively", () => {
    expect(splitCommands("/REVIEW", NAMES)).toEqual([{ text: "/REVIEW", command: true }]);
  });

  it("handles hyphenated command names", () => {
    expect(splitCommands("/start-task ENG-1", NAMES)[0]).toEqual({
      text: "/start-task",
      command: true,
    });
  });

  it("rebuilds the original text exactly", () => {
    for (const text of [
      "",
      "  ",
      "/review",
      "/init\n\nthen /review  please ",
      "no commands here",
    ]) {
      expect(rejoin(text)).toBe(text);
    }
  });

  it("returns the text untouched when no commands are known", () => {
    expect(splitCommands("/review", new Set())).toEqual([
      { text: "/review", command: false },
    ]);
  });
});
