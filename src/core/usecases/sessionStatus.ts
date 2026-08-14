import { modeFromAgentModeId } from "../entities/agentSettings";
import { infoMessage } from "../entities/message";
import type { AgentGateway, AgentTurnEvent } from "../ports/agentGateway";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * Use case — fold session-level agent events that arrive OUTSIDE a turn
 * into the app state: warm-up progress ("booting…"), agent-initiated
 * mode switches, and the id of a session as it boots. During a turn the
 * same events flow through SendPrompt; this covers the quiet stretches
 * in between — which is where a session is USUALLY born, since warm-up
 * runs long before the first prompt.
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
    // Warm-up is where a reconfigure respawn happens, so this notice
    // usually arrives with no turn running.
    if (event.kind === "notice") {
      this.store.dispatch({
        type: "chat/messageAppended",
        tabId,
        message: infoMessage(event.message),
      });
    }
    // The session a warm-up (or a history open) just created. Without
    // this the tab keeps whatever id it was restored with, and every
    // transcript it saves is stamped with a conversation the agent no
    // longer has — which is what made one chat list as two.
    if (event.kind === "session") {
      this.store.dispatch({
        type: "chat/sessionRecorded",
        tabId,
        provider: tab.project.provider,
        sessionId: event.providerSessionId,
      });
    }
    if (event.kind === "modeChanged") {
      const mapped = modeFromAgentModeId(event.modeId, tab.project.mode);
      if (mapped && mapped !== tab.project.mode) {
        this.store.dispatch({ type: "tab/modeChanged", tabId, mode: mapped });
      }
    }
  }
}
