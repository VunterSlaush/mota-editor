import { declineOption, pendingPlanApproval } from "../entities/approval";
import type { AgentGateway } from "../ports/agentGateway";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import { stopTurn } from "./stopTurn";

/** What the transcript says when a plan is turned down. */
export const PLAN_DECLINED = "Plan declined — the agent stopped and is waiting.";

/**
 * Turn down the plan the tab is parked on, if it is parked on one, and
 * stop the turn.
 *
 * Typing a message instead of clicking a button is itself an answer:
 * whatever the user has to say, they are not saying "go ahead". So the
 * agent is told no, then stopped, and their words become the next
 * instruction rather than a queued message the plan would swallow.
 */
export async function declineParkedPlan(
  store: Store,
  agentGateway: AgentGateway,
  tabId: string,
): Promise<void> {
  const tab = tabById(store.getState(), tabId);
  if (!tab) return;
  const approval = pendingPlanApproval(tab.messages);
  if (!approval) return;

  const decline = declineOption(approval.options);
  if (decline) {
    store.dispatch({
      type: "chat/approvalResolved",
      tabId,
      requestId: approval.requestId,
      optionId: decline.optionId,
    });
    await agentGateway.respondPermission(tabId, approval.requestId, decline.optionId);
  }
  // No decline option? Stopping still releases the request — the cancel
  // answers it — so the agent is never left holding an unanswered card.
  await stopTurn(store, agentGateway, tabId, PLAN_DECLINED);
}
