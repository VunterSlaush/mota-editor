import type { ProviderId } from "../entities/provider";
import type { SubagentInfo } from "../entities/subagent";

/**
 * Ports layer — boundary for discovering the sub-agents a provider can
 * hand a command off to. The provider's own built-ins are static domain
 * data; only the user's definitions need the outside world.
 *
 * Read-only, and deliberately so: these folders belong to the vendor and
 * the user. Mota points at what is already there rather than authoring
 * definitions that would outlive it in their plain CLI sessions.
 */
export interface AgentCatalog {
  listSubagents(projectPath: string, provider: ProviderId): Promise<SubagentInfo[]>;
}
