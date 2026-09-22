import {
  type AgentMode,
  executingMode,
  type PermissionPolicy,
} from "../entities/agentSettings";
import { pendingPlanApproval } from "../entities/approval";
import { executePlanPrompt } from "../entities/planHandoff";
import type { ProviderId } from "../entities/provider";
import type { AgentGateway } from "../ports/agentGateway";
import type { WorkspaceStore } from "../ports/workspacePort";
import { type TabState, tabById } from "../state/appState";
import type { Store } from "../state/store";
import { persistWorkspace } from "./persistWorkspace";
import { declineParkedPlan } from "./planApproval";
import { endConversation } from "./startNewChat";

/** What the user picked in the plan card's handoff panel. Empty strings
 *  mean "the provider's own default", exactly as the pickers use them. */
export interface FreshSessionSpec {
  readonly provider: ProviderId;
  readonly model: string;
  readonly effort: string;
  readonly permission: PermissionPolicy;
}

/** SendPrompt's verb, narrowed to the single call this use case makes —
 *  the handoff needs a turn started, not the rest of SendPrompt. */
export type StartTurnWithPrompt = (tabId: string, prompt: string) => Promise<void>;

/**
 * Use case — implement the plan the tab is parked on in a NEW session,
 * on a model the user picks.
 *
 * The model that writes a good plan is often not the one you want
 * executing it, and a plan is the one artifact that makes the swap
 * cheap: it was written to stand alone, so the executing agent needs
 * none of the planning conversation. That is also why the planning
 * session is ended rather than kept — an agent that keeps working after
 * the handoff is a second agent in the same repository.
 *
 * The order below is the design, not a sequence of conveniences: the
 * plan is captured before anything can wipe it, the old session is
 * ended before the provider changes so the right session id is dropped,
 * and the chosen spec is written after that reset so a model deferred
 * earlier in the conversation cannot win.
 */
export class ExecutePlanInFreshSession {
  constructor(
    private readonly store: Store,
    private readonly agentGateway: AgentGateway,
    private readonly workspaceStore: WorkspaceStore,
    private readonly startTurn: StartTurnWithPrompt,
  ) {}

  async execute(tabId: string, spec: FreshSessionSpec): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    // Guarded here rather than trusted downstream: declining a plan
    // clears `busy`, but only when there is a plan card left to decline.
    if (!tab || tab.busy) return;

    const prompt = executePlanPrompt(planToHandOver(tab));
    if (!prompt) return;

    await declineParkedPlan(this.store, this.agentGateway, tabId);
    await endConversation(this.store, this.agentGateway, tabId);
    this.applySpec(tabId, spec, executingMode(tab.project.mode));
    await persistWorkspace(this.store.getState(), this.workspaceStore);
    // The turn is the warm-up: warming as well would spawn two agents.
    await this.startTurn(tabId, prompt);
  }

  /**
   * Written straight to the tab, not through SelectModel and its
   * siblings: they would defer the model to protect a conversation this
   * use case has already thrown away, and each one would respawn the
   * agent and save the workspace again.
   */
  private applySpec(tabId: string, spec: FreshSessionSpec, mode: AgentMode): void {
    this.store.dispatch({ type: "tab/providerChanged", tabId, provider: spec.provider });
    this.store.dispatch({ type: "tab/modelChanged", tabId, model: spec.model });
    this.store.dispatch({ type: "tab/effortChanged", tabId, effort: spec.effort });
    this.store.dispatch({
      type: "tab/permissionChanged",
      tabId,
      permission: spec.permission,
    });
    this.store.dispatch({ type: "tab/modeChanged", tabId, mode });
  }
}

/**
 * The plan text to hand over: the card's own copy, falling back to the
 * tab's, which outlives a card the turn already cancelled.
 */
function planToHandOver(tab: TabState): string {
  return pendingPlanApproval(tab.messages)?.planMarkdown ?? tab.planMarkdown ?? "";
}
