import { invoke } from "@tauri-apps/api/core";
import type { McpServerSpec } from "../../core/entities/mcpServer";
import type { McpProbe, McpProbeResult } from "../../core/ports/mcpProbe";

interface WireResult {
  inventory: { toolCount: number; prefixTokens: number } | null;
  error: string | null;
}

/** Interface adapter — runs the MCP handshake via the Rust backend. */
export class TauriMcpProbe implements McpProbe {
  async probe(server: McpServerSpec): Promise<McpProbeResult> {
    const wire = await invoke<WireResult>("probe_mcp_server", {
      args: { command: server.command, args: [...server.args], env: server.env },
    }).catch((e: unknown) => ({ inventory: null, error: String(e) }) as WireResult);
    return {
      ...(wire.inventory ? { inventory: wire.inventory } : {}),
      ...(wire.error ? { error: wire.error } : {}),
    };
  }
}
