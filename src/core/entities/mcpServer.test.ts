import { describe, expect, it } from "vitest";
import {
  isRunnable,
  type McpServerConfig,
  serversForProvider,
  withProviderToggled,
} from "./mcpServer";

const server = (overrides: Partial<McpServerConfig> = {}): McpServerConfig => ({
  id: "s1",
  name: "files",
  command: "npx",
  args: ["-y", "@modelcontextprotocol/server-filesystem"],
  env: { ROOT: "/work" },
  enabledFor: ["claude"],
  ...overrides,
});

describe("MCP server entity", () => {
  it("hands an agent only the servers switched on for it", () => {
    const servers = [
      server(),
      server({ id: "s2", name: "search", enabledFor: ["gemini"] }),
    ];
    expect(serversForProvider(servers, "claude").map((s) => s.name)).toEqual(["files"]);
    expect(serversForProvider(servers, "gemini").map((s) => s.name)).toEqual(["search"]);
    expect(serversForProvider(servers, "codex")).toEqual([]);
  });

  it("lets one project override the provider toggle in both directions", () => {
    // The whole point of scoping: a server needed in one repo is
    // otherwise a fixed per-request cost in every other one.
    const servers = [server(), server({ id: "s2", name: "search", enabledFor: [] })];

    const names = (overrides: Record<string, boolean>) =>
      serversForProvider(servers, "claude", overrides).map((s) => s.name);

    expect(names({})).toEqual(["files"]);
    expect(names({ s1: false })).toEqual([]);
    expect(names({ s2: true })).toEqual(["files", "search"]);
    expect(names({ s1: false, s2: true })).toEqual(["search"]);
  });

  it("follows the provider toggle for servers it says nothing about", () => {
    const servers = [server(), server({ id: "s2", name: "search", enabledFor: [] })];
    expect(
      serversForProvider(servers, "claude", { s2: true }).map((s) => s.name),
    ).toEqual(["files", "search"]);
  });

  it("never launches a half-typed server, override or not", () => {
    const draft = server({ id: "s9", name: "", enabledFor: [] });
    expect(serversForProvider([draft], "claude", { s9: true })).toEqual([]);
  });

  it("strips the bookkeeping the agent has no use for", () => {
    const [spec] = serversForProvider([server()], "claude");
    expect(spec).toEqual({
      name: "files",
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem"],
      env: { ROOT: "/work" },
    });
  });

  it("never sends a half-typed server to an agent", () => {
    expect(isRunnable(server({ name: "  " }))).toBe(false);
    expect(isRunnable(server({ command: "" }))).toBe(false);
    const drafts = [server({ id: "s3", name: "", enabledFor: ["claude"] })];
    expect(serversForProvider(drafts, "claude")).toEqual([]);
  });

  it("toggles one provider without disturbing the others", () => {
    const both = withProviderToggled(server(), "codex", true);
    expect(both.enabledFor).toEqual(["claude", "codex"]);

    const off = withProviderToggled(both, "claude", false);
    expect(off.enabledFor).toEqual(["codex"]);
  });

  it("switching on a provider twice does not duplicate it", () => {
    const once = withProviderToggled(server(), "claude", true);
    expect(once.enabledFor).toEqual(["claude"]);
  });
});
