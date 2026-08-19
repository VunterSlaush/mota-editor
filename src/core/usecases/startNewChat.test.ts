import { describe, expect, it } from "vitest";
import { approvalMessage, userMessage } from "../entities/message";
import { newProject } from "../entities/project";
import type { AgentGateway } from "../ports/agentGateway";
import {
  defaultSettings,
  projectDefaults,
  type TabState,
  tabById,
} from "../state/appState";
import { Store } from "../state/store";
import type { ChatRetirement } from "./startNewChat";
import { startNewChat } from "./startNewChat";

const DEFAULTS = projectDefaults(defaultSettings);

class FakeGateway implements Partial<AgentGateway> {
  retired: string[] = [];
  ended: string[] = [];
  warmed: { tabId: string; chatId: string }[] = [];
  permissionResponses: { requestId: string; optionId: string }[] = [];
  cancelled: string[] = [];

  async retireSession(tabId: string) {
    this.retired.push(tabId);
  }
  async endSession(tabId: string) {
    this.ended.push(tabId);
  }
  async warmSession(spec: { tabId: string; chatId: string }) {
    this.warmed.push({ tabId: spec.tabId, chatId: spec.chatId });
  }
  async respondPermission(_tabId: string, requestId: string, optionId: string) {
    this.permissionResponses.push({ requestId, optionId });
  }
  async cancelTurn(tabId: string) {
    this.cancelled.push(tabId);
  }
}

class RecordingRetirement implements ChatRetirement {
  retiredChats: TabState[] = [];
  retire(tab: TabState): void {
    this.retiredChats.push(tab);
  }
}

function setup() {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", DEFAULTS),
  });
  store.dispatch({
    type: "chat/messageAppended",
    tabId: "t1",
    message: userMessage("watch CI and tell me"),
  });
  const gateway = new FakeGateway();
  const retirement = new RecordingRetirement();
  return { store, gateway, retirement, tab: () => tabById(store.getState(), "t1")! };
}

const asGateway = (fake: FakeGateway) => fake as unknown as AgentGateway;

describe("startNewChat", () => {
  it("mints a new conversation for the tab", async () => {
    const { store, gateway, tab } = setup();
    const before = tab().chatId;

    await startNewChat(store, asGateway(gateway), "t1");

    // Everything the old agent still says is addressed to `before`, so
    // this is the one thing that keeps it out of the fresh chat.
    expect(tab().chatId).not.toBe(before);
    expect(gateway.warmed).toEqual([{ tabId: "t1", chatId: tab().chatId }]);
  });

  it("retires the agent instead of killing it", async () => {
    const { store, gateway, retirement, tab } = setup();
    const before = tab();

    await startNewChat(store, asGateway(gateway), "t1", retirement);

    expect(gateway.retired).toEqual(["t1"]);
    expect(gateway.ended).toEqual([]);
    // Handed over while the conversation is still on the tab — after the
    // clear there is nothing left to file the agent's report against.
    expect(retirement.retiredChats).toHaveLength(1);
    expect(retirement.retiredChats[0].chatId).toBe(before.chatId);
    expect(retirement.retiredChats[0].messages).toHaveLength(1);
  });

  it("clears the screen and the session it was tied to", async () => {
    const { store, gateway, tab } = setup();
    store.dispatch({
      type: "chat/sessionRecorded",
      tabId: "t1",
      provider: "claude",
      sessionId: "agent-9",
    });
    store.dispatch({ type: "tab/usageUpdated", tabId: "t1", used: 5, size: 10 });

    await startNewChat(store, asGateway(gateway), "t1");

    expect(tab().messages).toEqual([]);
    expect(tab().project.providerSessions.claude).toBeUndefined();
    expect(tab().usage).toBeUndefined();
  });

  it("drops a prompt queued behind the conversation it ends", async () => {
    const { store, gateway, tab } = setup();
    store.dispatch({
      type: "chat/promptQueued",
      tabId: "t1",
      prompt: "and then deploy",
      attachments: [],
    });

    await startNewChat(store, asGateway(gateway), "t1");

    // "and then deploy" was written for the conversation above it.
    // Delivering it to an agent that has never seen that conversation
    // asks a stranger to finish somebody else's sentence.
    expect(tab().queued).toEqual([]);
  });

  it("turns down a plan the agent is still parked on", async () => {
    const { store, gateway } = setup();
    store.dispatch({
      type: "chat/messageAppended",
      tabId: "t1",
      message: approvalMessage("Ready to code?", {
        requestId: "7",
        isPlan: true,
        options: [
          { optionId: "yes", name: "Go ahead", kind: "allow_once" },
          { optionId: "no", name: "Keep planning", kind: "reject_once" },
        ],
      }),
    });

    await startNewChat(store, asGateway(gateway), "t1");

    // Parked means idle on screen and OPEN on the agent's side. Retiring
    // underneath it leaves the agent waiting on an answer that can no
    // longer be given, and its death rattle lands in the new chat.
    expect(gateway.permissionResponses).toEqual([{ requestId: "7", optionId: "no" }]);
    expect(gateway.cancelled).toEqual(["t1"]);
  });

  it("does nothing while a turn is running", async () => {
    const { store, gateway, retirement, tab } = setup();
    store.dispatch({ type: "chat/busyChanged", tabId: "t1", busy: true, at: 1 });
    const before = tab().chatId;

    await startNewChat(store, asGateway(gateway), "t1", retirement);

    expect(tab().chatId).toBe(before);
    expect(gateway.retired).toEqual([]);
    expect(retirement.retiredChats).toEqual([]);
  });
});
