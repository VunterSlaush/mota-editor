import type { ProviderId } from "../entities/provider";
import {
  BUILTIN_SUBAGENTS,
  dedupeSubagents,
  type SubagentInfo,
} from "../entities/subagent";
import type { AgentCatalog } from "../ports/agentCatalog";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * Use case — the sub-agents available in a tab: the provider's built-ins
 * plus the definitions discovered in the project and user agent folders.
 * Discovery failures degrade to built-ins only, exactly as ListCommands
 * does — a missing folder is the normal case, not an error.
 * Precedence on a name clash: builtins, then project, then user.
 */
export class ListSubagents {
  constructor(
    private readonly store: Store,
    private readonly agentCatalog: AgentCatalog,
  ) {}

  async execute(tabId: string): Promise<SubagentInfo[]> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return [];
    return this.forProvider(tab.project.path, tab.project.provider);
  }

  /**
   * The same list for a provider the tab is NOT currently using — the
   * settings screen configures every provider's commands, not just the
   * one in front of the user.
   */
  async forProvider(path: string, provider: ProviderId): Promise<SubagentInfo[]> {
    const discovered = await this.agentCatalog
      .listSubagents(path, provider)
      .catch(() => []);
    return dedupeSubagents([...BUILTIN_SUBAGENTS[provider], ...discovered]);
  }
}
