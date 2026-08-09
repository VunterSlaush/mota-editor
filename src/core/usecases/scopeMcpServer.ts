import type { AgentGateway } from "../ports/agentGateway";
import type { WorkspaceStore } from "../ports/workspacePort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";
import { warmTab } from "./warmSessions";

/**
 * Use case — switch an MCP server on or off for THIS project only
 * (undefined follows the provider-wide toggle).
 *
 * The lever: a server's tool definitions sit in the cached prefix of
 * every request for a whole session, so one needed in a single repo is
 * otherwise a standing cost in every other one.
 *
 * Servers are fixed when a session is created, so a change can only take
 * hold by respawning — the same expense SelectModel defers. Here it is
 * deferred by omission rather than queued: the change is recorded and
 * applies to the NEXT session, and the running agent is left alone. That
 * is the cheap default, and the user is told so on the settings screen.
 */
export class ScopeMcpServer {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(
    tabId: string,
    serverId: string,
    enabled: boolean | undefined,
  ): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return;
    this.store.dispatch({ type: "tab/mcpOverrideChanged", tabId, serverId, enabled });
    // Before the first turn there is no conversation to re-send, so the
    // new server list can take effect immediately and for free.
    if (!tab.project.providerSessions[tab.project.provider]) {
      warmTab(this.store, this.agentGateway, tabId);
    }
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}
