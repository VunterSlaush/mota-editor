import { describe, expect, it } from "vitest";
import { userMessage } from "../entities/message";
import { newProject } from "../entities/project";
import type { AgentGateway } from "../ports/agentGateway";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { defaultSettings, projectDefaults, tabById } from "../state/appState";
import { Store } from "../state/store";
import { ApplyPendingSpec, DiscardPendingSpec } from "./applyPendingSpec";
import { SelectEffort, SelectModel, SwitchTab } from "./switchTab";

class FakeAgentGateway implements Partial<AgentGateway> {
  warms = 0;
  async warmSession(): Promise<void> {
    this.warms += 1;
  }
}

class FakeWorkspaceStore implements WorkspaceStore {
  saved: PersistedWorkspace | null = null;
  async load() {
    return this.saved;
  }
  async save(workspace: PersistedWorkspace) {
    this.saved = workspace;
  }
}

const DEFAULTS = projectDefaults(defaultSettings);

function setup() {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", DEFAULTS),
  });
  const workspace = new FakeWorkspaceStore();
  const gateway = new FakeAgentGateway() as unknown as AgentGateway;
  return {
    store,
    workspace,
    gateway: gateway as unknown as FakeAgentGateway,
    selectModel: new SelectModel(store, workspace, gateway),
    selectEffort: new SelectEffort(store, workspace, gateway),
    applyPending: new ApplyPendingSpec(store, workspace, gateway),
    discardPending: new DiscardPendingSpec(store),
  };
}

/** Give the tab a live provider session, as warming it up would. */
function warmSession(store: Store) {
  store.dispatch({
    type: "chat/sessionRecorded",
    tabId: "t1",
    provider: "claude",
    sessionId: "native-1",
  });
}

/** ...and something for a respawned agent to re-ingest, as a first turn
 *  would. Without this the session is live but empty, which costs
 *  nothing to restart. */
function startConversation(store: Store) {
  warmSession(store);
  store.dispatch({
    type: "chat/messageAppended",
    tabId: "t1",
    message: userMessage("hello"),
  });
}

const tab = (store: Store) => tabById(store.getState(), "t1");

describe("SelectModel before a conversation exists", () => {
  it("applies the model and restarts the agent", async () => {
    // Nothing to re-ingest yet, so the respawn is free.
    const { store, gateway, selectModel } = setup();

    await selectModel.execute("t1", "opus");

    expect(tab(store)?.project.model).toBe("opus");
    expect(tab(store)?.pendingSpec).toBeUndefined();
    expect(gateway.warms).toBe(1);
  });

  it("persists the choice", async () => {
    const { workspace, selectModel } = setup();
    await selectModel.execute("t1", "opus");
    expect(workspace.saved?.projects[0].model).toBe("opus");
  });

  it("applies at once on a warmed session with nothing said in it", async () => {
    // The agent is running, but an empty conversation re-sends nothing:
    // deferring here would charge the user a decision, not money.
    const { store, gateway, selectModel } = setup();
    warmSession(store);

    await selectModel.execute("t1", "opus");

    expect(tab(store)?.project.model).toBe("opus");
    expect(tab(store)?.pendingSpec).toBeUndefined();
    expect(gateway.warms).toBe(1);
  });

  it("applies effort at once on that same empty session", async () => {
    const { store, gateway, selectEffort } = setup();
    warmSession(store);

    await selectEffort.execute("t1", "high");

    expect(tab(store)?.project.effort).toBe("high");
    expect(tab(store)?.pendingSpec).toBeUndefined();
    expect(gateway.warms).toBe(1);
  });
});

describe("SelectModel mid-conversation", () => {
  it("defers the change instead of respawning the agent", async () => {
    // The whole point: respawning here re-sends the conversation at
    // cache-write rates, so the change waits for the next chat.
    const { store, gateway, selectModel } = setup();
    startConversation(store);

    await selectModel.execute("t1", "opus");

    expect(tab(store)?.pendingSpec).toEqual({ model: "opus" });
    expect(tab(store)?.project.model).toBeUndefined();
    expect(gateway.warms).toBe(0);
  });

  it("does not persist a deferred change", async () => {
    // It is transient: restoring it later would apply a change to a
    // conversation that no longer exists.
    const { store, workspace, selectModel } = setup();
    startConversation(store);

    await selectModel.execute("t1", "opus");

    expect(workspace.saved).toBeNull();
  });

  it("defers effort on the same terms", async () => {
    const { store, gateway, selectEffort } = setup();
    startConversation(store);

    await selectEffort.execute("t1", "high");

    expect(tab(store)?.pendingSpec).toEqual({ effort: "high" });
    expect(gateway.warms).toBe(0);
  });

  it("accumulates a model and an effort change together", async () => {
    const { store, selectEffort, selectModel } = setup();
    startConversation(store);

    await selectModel.execute("t1", "opus");
    await selectEffort.execute("t1", "high");

    expect(tab(store)?.pendingSpec).toEqual({ model: "opus", effort: "high" });
  });

  it("drops the deferral when the user picks the running value back", async () => {
    // Otherwise the toolbar would promise a restart that changes nothing.
    const { store, selectModel } = setup();
    startConversation(store);

    await selectModel.execute("t1", "opus");
    await selectModel.execute("t1", "");

    expect(tab(store)?.pendingSpec).toBeUndefined();
  });

  it("treats picking the model already running as no change at all", async () => {
    const { store, gateway, selectModel } = setup();
    await selectModel.execute("t1", "opus"); // free — applied
    startConversation(store);

    await selectModel.execute("t1", "opus");

    expect(tab(store)?.pendingSpec).toBeUndefined();
    expect(gateway.warms).toBe(1); // only the pre-conversation one
  });
});

describe("resolving a deferred change", () => {
  it("applies it and respawns when the user asks for it now", async () => {
    const { applyPending, gateway, selectModel, store } = setup();
    startConversation(store);
    await selectModel.execute("t1", "opus");

    await applyPending.execute("t1");

    expect(tab(store)?.project.model).toBe("opus");
    expect(tab(store)?.pendingSpec).toBeUndefined();
    expect(gateway.warms).toBe(1);
  });

  it("persists the change once it is really applied", async () => {
    const { applyPending, selectModel, store, workspace } = setup();
    startConversation(store);
    await selectModel.execute("t1", "opus");

    await applyPending.execute("t1");

    expect(workspace.saved?.projects[0].model).toBe("opus");
  });

  it("does nothing when there is no deferred change", async () => {
    const { applyPending, gateway, store } = setup();
    startConversation(store);

    await applyPending.execute("t1");

    expect(gateway.warms).toBe(0);
  });

  it("forgets it when the user discards it", async () => {
    const { discardPending, selectModel, store } = setup();
    startConversation(store);
    await selectModel.execute("t1", "opus");

    discardPending.execute("t1");

    expect(tab(store)?.pendingSpec).toBeUndefined();
    expect(tab(store)?.project.model).toBeUndefined();
  });

  it("boots the next conversation with it, free of charge", async () => {
    // The deferral's natural resolution: a new session re-ingests
    // nothing, so the change costs zero here.
    const { selectModel, store } = setup();
    startConversation(store);
    await selectModel.execute("t1", "opus");

    store.dispatch({ type: "chat/sessionReset", tabId: "t1", provider: "claude" });

    expect(tab(store)?.project.model).toBe("opus");
    expect(tab(store)?.pendingSpec).toBeUndefined();
  });

  it("resolves a deferred switch back to the provider default", async () => {
    const { selectModel, store } = setup();
    await selectModel.execute("t1", "opus");
    startConversation(store);
    await selectModel.execute("t1", "");
    expect(tab(store)?.pendingSpec).toEqual({ model: "" });

    store.dispatch({ type: "chat/sessionReset", tabId: "t1", provider: "claude" });

    expect(tab(store)?.project.model).toBeUndefined();
  });
});

describe("SwitchTab.byIndex", () => {
  /** Three tabs on the strip, left to right, with the first active. */
  function strip() {
    const store = new Store();
    for (const [id, path] of [
      ["t1", "/work/alpha"],
      ["t2", "/work/beta"],
      ["t3", "/work/gamma"],
    ]) {
      store.dispatch({ type: "tab/opened", project: newProject(id, path, DEFAULTS) });
    }
    store.dispatch({ type: "tab/activated", tabId: "t1" });
    const workspace = new FakeWorkspaceStore();
    return { store, workspace, switchTab: new SwitchTab(store, workspace) };
  }

  it("activates the tab at that position on the strip", async () => {
    const { store, switchTab } = strip();

    await switchTab.byIndex(1);

    expect(store.getState().activeTabId).toBe("t2");
  });

  it("follows the strip, not the order the tabs were opened in", async () => {
    // The whole point of a positional binding: Ctrl+1 is whatever is
    // leftmost now, not whichever project got opened first.
    const { store, switchTab } = strip();
    store.dispatch({ type: "tab/moved", tabId: "t3", toIndex: 0 });

    await switchTab.byIndex(0);

    expect(store.getState().activeTabId).toBe("t3");
  });

  it("does nothing at a position past the last tab", async () => {
    // Not "the last tab": a shortcut that lands somewhere different
    // depending on how many tabs are open is worse than one that misses.
    const { store, switchTab } = strip();

    await switchTab.byIndex(7);

    expect(store.getState().activeTabId).toBe("t1");
  });

  it("persists the switch, so the tab is still active after a restart", async () => {
    const { workspace, switchTab } = strip();

    await switchTab.byIndex(2);

    expect(workspace.saved?.activeTabId).toBe("t3");
  });
});
