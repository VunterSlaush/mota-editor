import { extensionMcpServers } from "../entities/extension";
import {
  type McpServerSpec,
  type ProjectMcpOverrides,
  serversForProvider,
} from "../entities/mcpServer";
import type { ProviderId } from "../entities/provider";
import type { AppState } from "../state/appState";

/**
 * The MCP servers to hand an agent: the user's configured rows plus the
 * ones active extensions contribute (ADR-0012), through the same
 * enablement filter. Every session start funnels through here so the
 * two sources can never drift apart.
 */
export function agentServers(
  state: AppState,
  provider: ProviderId,
  overrides?: ProjectMcpOverrides,
): McpServerSpec[] {
  return serversForProvider(
    [...state.settings.mcpServers, ...extensionMcpServers(state.extensions)],
    provider,
    overrides,
  );
}
