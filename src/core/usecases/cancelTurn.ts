import type { AgentGateway } from "../ports/agentGateway";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import { stopTurn } from "./stopTurn";

/** Use case — stop the agent turn currently running in a tab. */
export class CancelTurn {
  constructor(
    private readonly store: Store,
    private readonly agentGateway: AgentGateway,
  ) {}

  async execute(tabId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab?.busy) return;

    await stopTurn(this.store, this.agentGateway, tabId, "Turn cancelled.");
  }
}
