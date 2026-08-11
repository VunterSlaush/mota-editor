import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { AgentGateway, AgentTurnEvent } from "../ports/agentGateway";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { SessionStatus } from "./sessionStatus";

/** Gateway that hands its session-level subscriber straight back. */
class FakeGateway implements AgentGateway {
  emit: (tabId: string, event: AgentTurnEvent) => void = () => {};

  subscribeSessionEvents(onEvent: (tabId: string, event: AgentTurnEvent) => void) {
    this.emit = onEvent;
  }
  subscribeAgentInitiated() {}
  async startTurn() {}
  async cancelTurn() {}
  async respondPermission() {}
  async respondQuestion() {}
  async endSession() {}
  async warmSession() {}
  async listNativeSessions() {
    return null;
  }
  async loadNativeSession() {
    return { replayed: true };
  }
  async readTerminalOutput() {
    return null;
  }
}

function setup() {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/repo", projectDefaults(defaultSettings)),
  });
  const gateway = new FakeGateway();
  new SessionStatus(store, gateway);
  return { store, gateway };
}

describe("SessionStatus", () => {
  it("records the session a warm-up created", () => {
    const { store, gateway } = setup();

    gateway.emit("t1", { kind: "session", providerSessionId: "agent-9" });

    // Warm-up runs long before the first prompt, so this is where a
    // session is usually born — a tab that misses it stamps every
    // transcript it saves with a conversation the agent no longer has.
    expect(store.getState().tabs[0].project.providerSessions.claude).toBe("agent-9");
  });

  it("folds warm-up stages and notices into the tab", () => {
    const { store, gateway } = setup();

    gateway.emit("t1", { kind: "sessionStage", stage: "booting" });
    gateway.emit("t1", { kind: "notice", message: "Agent restarted." });

    const tab = store.getState().tabs[0];
    expect(tab.sessionStage).toBe("booting");
    expect(tab.messages.at(-1)?.text).toBe("Agent restarted.");
  });

  it("ignores events for a tab that is already closed", () => {
    const { store, gateway } = setup();

    expect(() =>
      gateway.emit("gone", { kind: "session", providerSessionId: "agent-9" }),
    ).not.toThrow();
    expect(store.getState().tabs[0].project.providerSessions.claude).toBeUndefined();
  });
});
