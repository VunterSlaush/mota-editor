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
