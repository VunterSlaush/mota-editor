import type { AgentGateway } from "../ports/agentGateway";
import type { WorkspaceStore } from "../ports/workspacePort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";
import { warmTab } from "./warmSessions";

/**
 * Use case — apply a deferred model/effort change NOW, accepting the
 * respawn.
 *
 * SelectModel/SelectEffort hold such a change back mid-conversation
 * because applying it re-sends the whole context. Sometimes that is
 * worth it: the user wants a stronger model on the problem in front of
 * them, not on the next one. This is that choice, made explicitly.
 *
 * A separate use case rather than a flag on SelectModel, per the house
 * rule against boolean flag arguments — and because "change the model"
 * and "spend money to change the model mid-conversation" are genuinely
 * different actions.
 */
export class ApplyPendingSpec {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(tabId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab?.pendingSpec) return;
    this.store.dispatch({ type: "tab/pendingSpecApplied", tabId });
    // Respawns the agent with the new spec; the conversation is resumed
    // into it rather than lost.
    warmTab(this.store, this.agentGateway, tabId);
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }
}

/**
 * Use case — drop a deferred change and keep running as-is.
 *
 * Synchronous and storage-free on purpose: a pending spec was never
 * persisted, so forgetting it touches nothing but the screen.
 */
export class DiscardPendingSpec {
  constructor(private readonly store: Store) {}

  execute(tabId: string): void {
    this.store.dispatch({ type: "tab/pendingSpecDiscarded", tabId });
  }
}
