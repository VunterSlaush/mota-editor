import { describe, expect, it } from "vitest";
import { approvalMessage } from "../entities/message";
import { newProject } from "../entities/project";
import type {
  AgentGateway,
  AgentTurnEvent,
  AgentTurnRequest,
} from "../ports/agentGateway";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { RespondPermission } from "./respondPermission";

class RecordingGateway implements AgentGateway {
  responses: Array<{ tabId: string; requestId: string; optionId: string }> = [];

  async startTurn(
    _request: AgentTurnRequest,
    _onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {}
  async cancelTurn(): Promise<void> {}
  async endSession(): Promise<void> {}
  async warmSession(): Promise<void> {}
  async listNativeSessions(): Promise<{ sessionId: string }[]> {
    return [];
  }
  async loadNativeSession(): Promise<void> {}
  async respondPermission(tabId: string, requestId: string, optionId: string) {
    this.responses.push({ tabId, requestId, optionId });
  }
}

function setup() {
  const store = new Store();
  store.dispatch({ type: "tab/opened", project: newProject("t1", "/a", DEFAULTS) });
  store.dispatch({
    type: "chat/messageAppended",
    tabId: "t1",
    message: approvalMessage("Run npm test", "9", [
      { optionId: "allow", name: "Allow", kind: "allow_once" },
    ]),
  });
  const gateway = new RecordingGateway();
  return { store, gateway, useCase: new RespondPermission(store, gateway) };
}

const DEFAULTS = projectDefaults(defaultSettings);

describe("RespondPermission", () => {
  it("delivers the choice and marks the approval answered", async () => {
    const { store, gateway, useCase } = setup();

    await useCase.execute("t1", "9", "allow");

    expect(gateway.responses).toEqual([
      { tabId: "t1", requestId: "9", optionId: "allow" },
    ]);
    const approval = store.getState().tabs[0].messages[0].approval;
    expect(approval?.resolvedOptionId).toBe("allow");
  });

  it("ignores a second answer to the same request", async () => {
    const { gateway, useCase } = setup();

    await useCase.execute("t1", "9", "allow");
    await useCase.execute("t1", "9", "reject");

    expect(gateway.responses).toHaveLength(1);
  });

  it("ignores answers to cancelled approvals", async () => {
    const { store, gateway, useCase } = setup();
    store.dispatch({ type: "chat/approvalsCancelled", tabId: "t1" });

    await useCase.execute("t1", "9", "allow");

    expect(gateway.responses).toHaveLength(0);
  });
});
