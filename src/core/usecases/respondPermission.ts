import { isDecline } from "../entities/approval";
import { pendingApproval, pendingQuestion } from "../entities/message";
import type { AgentGateway } from "../ports/agentGateway";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import { PLAN_DECLINED } from "./planApproval";
import { stopTurn } from "./stopTurn";

/**
 * Use case — deliver the user's Allow/Deny choice for a pending
 * permission request back to the agent, and mark the approval card
 * answered so it can't be clicked twice.
 *
 * A plan approval is the exception: the turn parked on it when it
 * appeared, so answering has to say where the turn goes next. Approving
 * sets it running again; declining stops the agent outright, because an
 * agent that keeps researching after "no" is not waiting for the
 * instructions the user is trying to give it.
 */
export class RespondPermission {
  constructor(
    private readonly store: Store,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(tabId: string, requestId: string, optionId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    const approval = pendingApproval(tab?.messages ?? [], requestId)?.approval;
    if (!approval) return;

    this.store.dispatch({ type: "chat/approvalResolved", tabId, requestId, optionId });
    await this.agentGateway.respondPermission(tabId, requestId, optionId);

    if (!approval.isPlan) return;
    if (isDecline(approval.options, optionId)) {
      await stopTurn(this.store, this.agentGateway, tabId, PLAN_DECLINED);
    } else {
      this.store.dispatch({
        type: "chat/busyChanged",
        tabId,
        busy: true,
        at: Date.now(),
      });
    }
  }
}

/**
 * Use case — deliver the user's answers to a question the agent asked,
 * and mark the card answered so it can't be submitted twice. An empty
 * `answers` is a deliberate skip: the agent is told to carry on without
 * them rather than the turn being aborted.
 */
export class RespondQuestion {
  constructor(
    private readonly store: Store,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(
    tabId: string,
    requestId: string,
    answers: Readonly<Record<string, string>>,
  ): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!pendingQuestion(tab?.messages ?? [], requestId)) return;

    this.store.dispatch({ type: "chat/questionAnswered", tabId, requestId, answers });
    await this.agentGateway.respondQuestion(tabId, requestId, answers);
  }
}
