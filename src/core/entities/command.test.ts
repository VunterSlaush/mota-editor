import { describe, expect, it } from "vitest";
import {
  BUILTIN_COMMANDS,
  type CommandInfo,
  commandNames,
  dedupeCommands,
  filterCommands,
  MOTA_COMMANDS,
  paletteCommands,
  splitCommands,
} from "./command";

const COMMANDS: readonly CommandInfo[] = [
  { name: "/review", description: "Review changes", source: "builtin" },
  { name: "/init", description: "Write CLAUDE.md", source: "builtin" },
  { name: "/start-task", description: "Start from Linear", source: "project" },
];

const NAMES = commandNames(COMMANDS);

/** The highlight must never alter what the user typed. */
const rejoin = (text: string) =>
  splitCommands(text, NAMES)
    .map((s) => s.text)
    .join("");

describe("paletteCommands", () => {
  // What a live ACP session reports: the CLI's real builtins, and nothing
  // it has never heard of.
  const FROM_AGENT: readonly CommandInfo[] = [
    { name: "/compact", description: "Compact the conversation", source: "builtin" },
    { name: "/review", description: "Review the diff", source: "builtin" },
  ];
  const DISCOVERED: readonly CommandInfo[] = [
    ...BUILTIN_COMMANDS.claude,
    { name: "/standup", description: "Draft a standup", source: "extension" },
    { name: "/start-task", description: "Start from Linear", source: "project" },
  ];

  const names = (commands: readonly CommandInfo[]) => commands.map((c) => c.name);

  it("keeps Mota's own commands, which no agent can advertise", () => {
    // The bug this function exists for: a live session used to replace
    // the whole list, and /install-extension — the only way most people
    // will ever find the store — disappeared the moment one came up.
    const merged = names(paletteCommands(FROM_AGENT, DISCOVERED));
    for (const own of MOTA_COMMANDS) expect(merged).toContain(own.name);
  });

  it("keeps extension and file commands, which no agent knows about", () => {
    const merged = names(paletteCommands(FROM_AGENT, DISCOVERED));
    expect(merged).toContain("/standup");
    expect(merged).toContain("/start-task");
  });

  it("lets the live list supersede the static builtins", () => {
    const merged = paletteCommands(FROM_AGENT, DISCOVERED);
    // /init is in the static table but not in this agent's answer, so it
    // is not offered; /review is offered as the agent described it.
    expect(names(merged)).not.toContain("/init");
    expect(merged.find((c) => c.name === "/review")?.description).toBe("Review the diff");
  });

  it("offers each name once", () => {
    const merged = names(paletteCommands(FROM_AGENT, DISCOVERED));
    expect(merged.length).toBe(new Set(merged).size);
  });

  it("is alphabetical, so a session starting does not reshuffle the palette", () => {
    const merged = names(paletteCommands(FROM_AGENT, DISCOVERED));
    expect(merged).toEqual([...merged].sort((a, b) => a.localeCompare(b)));
  });

  it("is the discovered list untouched before any session answers", () => {
    expect(paletteCommands([], DISCOVERED)).toEqual(DISCOVERED);
  });
});

describe("filterCommands", () => {
  it("matches on prefix, ignoring case", () => {
    expect(filterCommands(COMMANDS, "/i").map((c) => c.name)).toEqual(["/init"]);
    expect(filterCommands(COMMANDS, "/REV").map((c) => c.name)).toEqual(["/review"]);
    expect(filterCommands(COMMANDS, "/nope")).toEqual([]);
  });
});

describe("dedupeCommands", () => {
  it("keeps one entry per name, first occurrence winning", () => {
    const listed = dedupeCommands([
      { name: "/prepare-pr", description: "from command file", source: "project" },
      { name: "/prepare-pr", description: "from skill", source: "project" },
      { name: "/review", description: "Review changes", source: "builtin" },
      { name: "/prepare-pr", description: "from plugin", source: "project" },
    ]);
    expect(listed.map((c) => c.name)).toEqual(["/prepare-pr", "/review"]);
    expect(listed[0].description).toBe("from command file");
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
