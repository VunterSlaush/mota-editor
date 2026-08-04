import { infoMessage } from "../entities/message";
import type { AgentGateway } from "../ports/agentGateway";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/** Use case — stop the agent turn currently running in a tab. */
export class CancelTurn {
  constructor(
    private readonly store: Store,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(tabId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab?.busy) return;

    await this.agentGateway.cancelTurn(tabId);
    const queuedCount = tab.queued.length;
    if (queuedCount > 0) {
      // Stopping means "stop" — don't fire messages the user queued
      // for a turn they just killed.
      this.store.dispatch({ type: "chat/queueCleared", tabId });
    }
    this.store.dispatch({
      type: "chat/messageAppended",
      tabId,
      message: infoMessage(
        queuedCount > 0
          ? `Turn cancelled. Discarded ${queuedCount} queued message${queuedCount > 1 ? "s" : ""}.`
          : "Turn cancelled.",
      ),
    });
    this.store.dispatch({ type: "chat/busyChanged", tabId, busy: false });
  }
}
