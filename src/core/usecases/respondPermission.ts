import type { AgentGateway } from "../ports/agentGateway";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

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
    const approval = tab?.messages.find(
      (m) => m.approval?.requestId === requestId,
    )?.approval;
    if (!approval || approval.resolvedOptionId || approval.cancelled) return;

    this.store.dispatch({ type: "chat/approvalResolved", tabId, requestId, optionId });
    await this.agentGateway.respondPermission(tabId, requestId, optionId);
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
    const question = tab?.messages.find(
      (m) => m.question?.requestId === requestId,
    )?.question;
    if (!question || question.answers || question.skipped || question.cancelled) return;

    this.store.dispatch({ type: "chat/questionAnswered", tabId, requestId, answers });
    await this.agentGateway.respondQuestion(tabId, requestId, answers);
  }
}
