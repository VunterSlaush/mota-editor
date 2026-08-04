import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import type { AgentGateway } from "../ports/agentGateway";

/**
 * Use case — deliver the user's Allow/Deny choice for a pending
 * permission request back to the agent, and mark the approval card
 * answered so it can't be clicked twice.
 */
export class RespondPermission {
  constructor(
    private readonly store: Store,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(tabId: string, requestId: string, optionId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    const approval = tab?.messages.find((m) => m.approval?.requestId === requestId)?.approval;
    if (!approval || approval.resolvedOptionId || approval.cancelled) return;

    this.store.dispatch({ type: "chat/approvalResolved", tabId, requestId, optionId });
    await this.agentGateway.respondPermission(tabId, requestId, optionId);
  }
}
