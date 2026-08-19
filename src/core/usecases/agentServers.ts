import { extensionMcpServers } from "../entities/extension";
import {
  type McpServerSpec,
  type ProjectMcpOverrides,
  serversForProvider,
} from "../entities/mcpServer";
import type { ProviderId } from "../entities/provider";
import type { SessionSpec } from "../ports/agentGateway";
import type { AppState, TabState } from "../state/appState";

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

/**
 * How a tab describes the agent session it wants. Every caller that boots,
 * reuses or interrogates a session builds it here, so none of them can
 * forget the chat id that stamps the session's events.
 */
export function sessionSpec(state: AppState, tab: TabState): SessionSpec {
  const { id, provider, path, model, effort, mcpOverrides, subtask } = tab.project;
  return {
    tabId: id,
    chatId: tab.chatId,
    provider,
    projectPath: path,
    model,
    effort,
    mcpServers: agentServers(state, provider, mcpOverrides),
    subtask,
  };
}
