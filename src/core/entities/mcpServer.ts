import type { ProviderId } from "./provider";

/**
 * Entities layer — an MCP server the workbench hands to an agent.
 *
 * ACP passes these when a session is created, so the agent gains the
 * server's tools for that conversation. The protocol offers no way to
 * READ BACK what the vendor CLI already loaded from its own config, so
 * this list is what Mota injects — never a full picture of the agent's
 * tools.
 */
export interface McpServerConfig {
  readonly id: string;
  /** Name the agent will show the tools under. */
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Providers this server is switched on for. */
  readonly enabledFor: readonly ProviderId[];
}

/**
 * The same server as the AGENT needs it: the id and the per-provider
 * toggles are the workbench's bookkeeping and mean nothing over ACP.
 */
export interface McpServerSpec {
  readonly name: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
}

export function isEnabledFor(server: McpServerConfig, provider: ProviderId): boolean {
  return server.enabledFor.includes(provider);
}

/**
 * The servers to hand a provider's agent, stripped to what the agent
 * needs. Unrunnable rows are dropped here rather than at the boundary:
 * a half-typed server is a draft, not a tool.
 */
export function serversForProvider(
  servers: readonly McpServerConfig[],
  provider: ProviderId,
): McpServerSpec[] {
  return servers
    .filter((server) => isEnabledFor(server, provider) && isRunnable(server))
    .map(({ name, command, args, env }) => ({ name, command, args, env }));
}

/** A server with one provider switched on or off. */
export function withProviderToggled(
  server: McpServerConfig,
  provider: ProviderId,
  enabled: boolean,
): McpServerConfig {
  const without = server.enabledFor.filter((p) => p !== provider);
  return { ...server, enabledFor: enabled ? [...without, provider] : without };
}

/** Blank rows would reach the agent as a server it cannot launch. */
export function isRunnable(server: McpServerConfig): boolean {
  return server.name.trim().length > 0 && server.command.trim().length > 0;
}
