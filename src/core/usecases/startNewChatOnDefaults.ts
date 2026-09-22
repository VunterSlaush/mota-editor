import type { ProjectDefaults } from "../entities/project";
import type { AgentGateway } from "../ports/agentGateway";
import type { WorkspaceStore } from "../ports/workspacePort";
import { projectDefaults, tabById } from "../state/appState";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";
import { endConversation } from "./startNewChat";
import { warmTab } from "./warmSessions";

/**
 * Use case — the New chat button: a conversation that starts where a
 * freshly opened tab would, on the app's own defaults.
 *
 * A tab drifts. A model switched for one hard question, a permission
 * raised for one risky step, a provider handed a plan to carry out — each
 * was a decision about the conversation being had, and every one of them
 * outlived it, because ending a conversation never touched the settings.
 * The result was a tab whose pickers recorded a history nobody chose.
 *
 * This is deliberately NOT what the other new-chat paths do. The History
 * panel, the context-full bar, the `/clear` command and the auto-compact
 * policy all continue the work in hand with the settings it was being
 * done with — swapping the model out from under a long task because its
 * context filled up would be a change the user never asked for. Only the
 * button that says "New chat" in so many words means a clean slate.
 */
export class StartNewChatOnDefaults {
  constructor(
    private readonly store: Store,
    private readonly agentGateway: AgentGateway,
    private readonly workspaceStore: WorkspaceStore,
  ) {}

  async execute(tabId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    // Clearing the screen out from under a live turn would orphan it.
    if (!tab || tab.busy) return;

    // Before the settings move: this is what drops the resume id of the
    // provider being LEFT, which is only knowable while it is still set.
    await endConversation(this.store, this.agentGateway, tabId);
    this.applyDefaults(tabId, projectDefaults(this.store.getState().settings));
    await persistWorkspace(this.store.getState(), this.workspaceStore);
    warmTab(this.store, this.agentGateway, tabId);
  }

  /**
   * Dispatched after the session reset, which is where a deferred
   * model/effort change lands. The defaults overwrite it on purpose:
   * both answer "what should the next chat run?", and this button is the
   * answer the user gave second.
   */
  private applyDefaults(tabId: string, defaults: ProjectDefaults): void {
    this.store.dispatch({
      type: "tab/providerChanged",
      tabId,
      provider: defaults.provider,
    });
    this.store.dispatch({ type: "tab/modeChanged", tabId, mode: defaults.mode });
    this.store.dispatch({
      type: "tab/permissionChanged",
      tabId,
      permission: defaults.permission,
    });
    // Empty is itself a default — "whatever the provider picks" — so an
    // unset app default must CLEAR the tab's model rather than keep it.
    this.store.dispatch({ type: "tab/modelChanged", tabId, model: defaults.model ?? "" });
    this.store.dispatch({
      type: "tab/effortChanged",
      tabId,
      effort: defaults.effort ?? "",
    });
  }
}
