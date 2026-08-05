import { modeFromAgentModeId } from "../entities/agentSettings";
import type { AgentGateway, AgentTurnEvent } from "../ports/agentGateway";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * Use case — fold session-level agent events that arrive OUTSIDE a turn
 * into the app state: warm-up progress ("booting…") and agent-initiated
 * mode switches. During a turn the same events flow through SendPrompt;
 * this covers the quiet stretches in between.
 */
export class SessionStatus {
  constructor(
    private readonly store: Store,
    agentGateway: AgentGateway,
  ) {
    agentGateway.subscribeSessionEvents((tabId, event) => this.onEvent(tabId, event));
  }

  private onEvent(tabId: string, event: AgentTurnEvent): void {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return;

    if (event.kind === "sessionStage") {
      this.store.dispatch({
        type: "tab/sessionStageChanged",
        tabId,
        stage: event.stage === "ready" ? undefined : event.stage,
      });
    }
    if (event.kind === "modeChanged") {
      const mapped = modeFromAgentModeId(event.modeId);
      if (mapped && mapped !== tab.project.mode) {
        this.store.dispatch({ type: "tab/modeChanged", tabId, mode: mapped });
      }
    }
  }
}
