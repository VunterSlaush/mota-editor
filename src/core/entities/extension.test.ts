import { describe, expect, it } from "vitest";
import {
  commandsFromExtensions,
  type ExtensionDescriptor,
  expandPromptCommand,
  extensionMcpServers,
  findExtensionCommand,
  isActive,
} from "./extension";
import { parseExtensionActions } from "./extensionActions";

function extension(overrides: Partial<ExtensionDescriptor>): ExtensionDescriptor {
  return {
    id: "standup",
    displayName: "Standup",
    version: "0.1.0",
    description: "",
    origin: "user",
    path: "~/.mota/extensions/standup",
    permissions: ["commands:register"],
    status: "enabled",
    commands: [],
    mcpServers: [],
    events: [],
    ...overrides,
  };
}

describe("expandPromptCommand", () => {
  it("substitutes $ARGUMENTS where present", () => {
    expect(expandPromptCommand("Summarize $ARGUMENTS days.", "3")).toBe(
      "Summarize 3 days.",
    );
  });

  it("appends the arguments when the template has no marker", () => {
    expect(expandPromptCommand("Draft a standup.", "for the demo")).toBe(
      "Draft a standup.\n\nfor the demo",
    );
    expect(expandPromptCommand("Draft a standup.", "")).toBe("Draft a standup.");
  });
});

describe("isActive", () => {
  it("counts enabled, running and crashed; not the ungrated states", () => {
    expect(isActive(extension({ status: "enabled" }))).toBe(true);
    expect(isActive(extension({ status: "running" }))).toBe(true);
    expect(isActive(extension({ status: "crashed" }))).toBe(true);
    expect(isActive(extension({ status: "needs-approval" }))).toBe(false);
    expect(isActive(extension({ status: "disabled" }))).toBe(false);
    expect(isActive(extension({ status: "invalid" }))).toBe(false);
  });
});

describe("commandsFromExtensions", () => {
  const draft = {
    name: "standup",
    description: "Draft a standup",
    kind: "prompt" as const,
    template: "x",
  };

  it("lists a bare name when nothing contests it", () => {
    const commands = commandsFromExtensions([extension({ commands: [draft] })], "claude");
    expect(commands).toEqual([
      {
        name: "/standup",
        description: "Draft a standup",
        source: "extension",
        extensionId: "standup",
      },
    ]);
  });

  it("qualifies a name a builtin claims", () => {
    const commands = commandsFromExtensions(
      [extension({ commands: [{ ...draft, name: "review" }] })],
      "claude",
    );
    expect(commands[0]?.name).toBe("/standup.review");
  });

  it("qualifies both when two extensions collide", () => {
    const a = extension({ id: "aa", commands: [draft] });
    const b = extension({ id: "bb", commands: [draft] });
    const names = commandsFromExtensions([a, b], "claude").map((c) => c.name);
    expect(names).toEqual(["/aa.standup", "/bb.standup"]);
  });

  it("skips extensions that are not active", () => {
    const off = extension({ status: "needs-approval", commands: [draft] });
    expect(commandsFromExtensions([off], "claude")).toEqual([]);
  });
});

describe("findExtensionCommand", () => {
  const ext = extension({
    commands: [{ name: "standup", description: "", kind: "prompt", template: "x" }],
  });

  it("resolves the bare and the qualified form", () => {
    expect(findExtensionCommand([ext], "claude", "/standup")?.command.name).toBe(
      "standup",
    );
    expect(findExtensionCommand([ext], "claude", "/standup.standup")?.command.name).toBe(
      "standup",
    );
  });

  it("never lets a bare name shadow a builtin", () => {
    const clash = extension({
      commands: [{ name: "review", description: "", kind: "prompt", template: "x" }],
    });
    expect(findExtensionCommand([clash], "claude", "/review")).toBeNull();
    expect(findExtensionCommand([clash], "claude", "/standup.review")).not.toBeNull();
  });

  it("refuses an ambiguous bare name", () => {
    const a = extension({ id: "aa", commands: ext.commands });
    const b = extension({ id: "bb", commands: ext.commands });
    expect(findExtensionCommand([a, b], "claude", "/standup")).toBeNull();
    expect(findExtensionCommand([a, b], "claude", "/aa.standup")).not.toBeNull();
  });

  it("ignores inactive extensions and plain prose", () => {
    const off = extension({ status: "disabled", commands: ext.commands });
    expect(findExtensionCommand([off], "claude", "/standup")).toBeNull();
    expect(findExtensionCommand([ext], "claude", "standup")).toBeNull();
  });
});

describe("extensionMcpServers", () => {
  it("derives namespaced rows from active extensions only", () => {
    const withServer = extension({
      permissions: ["tools:register"],
      mcpServers: [{ name: "tools", command: "node", args: ["mcp.js"], env: {} }],
    });
    const off = extension({
      id: "other",
      status: "disabled",
      mcpServers: [{ name: "t2", command: "node", args: [], env: {} }],
    });
    const rows = extensionMcpServers([withServer, off]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("ext:standup:tools");
    expect(rows[0]?.enabledFor.length).toBeGreaterThan(0);
  });
});

describe("parseExtensionActions", () => {
  it("accepts the known actions and drops the rest", () => {
    const actions = parseExtensionActions({
      actions: [
        { type: "notify", title: "t", message: "m" },
        { type: "insertPrompt", text: "draft" },
        { type: "startTurn", prompt: "go" },
        { type: "formatDisk" },
        "garbage",
      ],
    });
    expect(actions).toEqual([
      { type: "notify", title: "t", message: "m" },
      { type: "insertPrompt", text: "draft" },
      { type: "startTurn", prompt: "go" },
    ]);
  });

  it("returns nothing for non-action payloads", () => {
    expect(parseExtensionActions(null)).toEqual([]);
    expect(parseExtensionActions({ ok: true })).toEqual([]);
    expect(parseExtensionActions({ actions: "nope" })).toEqual([]);
  });

  it("caps text lengths and action counts", () => {
    const actions = parseExtensionActions({
      actions: Array.from({ length: 30 }, () => ({
        type: "insertPrompt",
        text: "x".repeat(50_000),
      })),
    });
    expect(actions).toHaveLength(10);
    expect((actions[0] as { text: string }).text.length).toBe(20_000);
  });
});
