import type { McpServerSpec } from "../entities/mcpServer";

/** What a server's tools cost to carry on every request. */
export interface ToolInventory {
  readonly toolCount: number;
  /** Estimated tokens the tool definitions add to every request. */
  readonly prefixTokens: number;
}

export interface McpProbeResult {
  readonly inventory?: ToolInventory;
  /** Why the count is unknown, phrased for the server's row. */
  readonly error?: string;
}

/**
 * Ports layer — ask an MCP server what tools it offers.
 *
 * ACP cannot answer this: a session takes the server list and reports
 * nothing back about it, so the only way to see what those tools cost is
 * to run the MCP handshake directly. Implementations START A PROCESS,
 * which is why callers do this on request and never in the background.
 *
 * Scope: this covers the servers MOTA launches. The agent also loads
 * servers from its own CLI config, invisible to us — so a total from
 * here is a floor on the real prefix, not the whole of it.
 */
export interface McpProbe {
  probe(server: McpServerSpec): Promise<McpProbeResult>;
}
