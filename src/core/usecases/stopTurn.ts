import { infoMessage } from "../entities/message";
import type { AgentGateway } from "../ports/agentGateway";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * End the tab's running turn and leave the conversation in a state the
 * user can act on: the agent told to stop, unanswered cards released,
 * the queue dropped, and the tab idle.
 *
 * Shared by the Stop button and by declining a plan, which is the same
 * act wearing different words — "stop what you are doing and wait".
 */
export async function stopTurn(
  store: Store,
  agentGateway: AgentGateway,
  tabId: string,
  reason: string,
): Promise<void> {
  const tab = tabById(store.getState(), tabId);
  if (!tab) return;

  await agentGateway.cancelTurn(tabId);
  // Belt and braces: the turn's real `completed` normally cancels
  // pending cards, but if the agent never acknowledges the cancel the
  // cards must not sit there looking answerable.
  store.dispatch({ type: "chat/approvalsCancelled", tabId });
  const queuedCount = tab.queued.length;
  if (queuedCount > 0) {
    // Stopping means "stop" — don't fire messages the user queued
    // for a turn they just killed.
    store.dispatch({ type: "chat/queueCleared", tabId });
  }
  store.dispatch({
    type: "chat/messageAppended",
    tabId,
    message: infoMessage(
      queuedCount > 0
        ? `${reason} Discarded ${queuedCount} queued message${queuedCount > 1 ? "s" : ""}.`
        : reason,
    ),
  });
  store.dispatch({ type: "chat/busyChanged", tabId, busy: false });
}
