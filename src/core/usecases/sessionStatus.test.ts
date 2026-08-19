import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type {
  AgentEventEnvelope,
  AgentGateway,
  AgentTurnEvent,
} from "../ports/agentGateway";
import { defaultSettings, projectDefaults, tabById } from "../state/appState";
import { Store } from "../state/store";
import { SessionStatus } from "./sessionStatus";

/** Gateway that hands its session-level subscriber straight back. */
class FakeGateway implements AgentGateway {
  send: (envelope: AgentEventEnvelope) => void = () => {};

  subscribeSessionEvents(onEvent: (envelope: AgentEventEnvelope) => void) {
    this.send = onEvent;
  }
  subscribeAgentInitiated() {}
  async startTurn() {}
  async cancelTurn() {}
  async respondPermission() {}
  async respondQuestion() {}
  async endSession() {}
  async retireSession() {}
  async discardRetired() {}
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
  /** As the tab's own session speaks: stamped with the chat it serves. */
  const emit = (event: AgentTurnEvent) =>
    gateway.send({ tabId: "t1", chatId: tabById(store.getState(), "t1")?.chatId, event });
  return { store, gateway, emit };
}

describe("SessionStatus", () => {
  it("records the session a warm-up created", () => {
    const { store, emit } = setup();

    emit({ kind: "session", providerSessionId: "agent-9" });

    // Warm-up runs long before the first prompt, so this is where a
    // session is usually born — a tab that misses it stamps every
    // transcript it saves with a conversation the agent no longer has.
    expect(store.getState().tabs[0].project.providerSessions.claude).toBe("agent-9");
  });

  it("folds warm-up stages and notices into the tab", () => {
    const { store, emit } = setup();

    emit({ kind: "sessionStage", stage: "booting" });
    emit({ kind: "notice", message: "Agent restarted." });

    const tab = store.getState().tabs[0];
    expect(tab.sessionStage).toBe("booting");
    expect(tab.messages.at(-1)?.text).toBe("Agent restarted.");
  });

  it("ignores events for a tab that is already closed", () => {
    const { store, gateway } = setup();

    expect(() =>
      gateway.send({
        tabId: "gone",
        event: { kind: "session", providerSessionId: "agent-9" },
      }),
    ).not.toThrow();
    expect(store.getState().tabs[0].project.providerSessions.claude).toBeUndefined();
  });

  it("ignores a session the user has already replaced", () => {
    const { store, gateway } = setup();

    // A session ended by "New chat" still announces itself on its way
    // out. Recording its id would make the next transcript claim a
    // conversation the tab's agent has never had.
    gateway.send({
      tabId: "t1",
      chatId: "t1#0",
      event: { kind: "session", providerSessionId: "agent-9" },
    });

    expect(store.getState().tabs[0].project.providerSessions.claude).toBeUndefined();
  });
});
