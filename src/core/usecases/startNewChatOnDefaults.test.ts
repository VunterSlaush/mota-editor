import { beforeEach, describe, expect, it } from "vitest";
import { userMessage } from "../entities/message";
import { newProject } from "../entities/project";
import type { ProviderId } from "../entities/provider";
import type {
  AgentGateway,
  AgentTurnEvent,
  AgentTurnRequest,
} from "../ports/agentGateway";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { StartNewChatOnDefaults } from "./startNewChatOnDefaults";

class FakeWorkspaceStore implements WorkspaceStore {
  saved: PersistedWorkspace | null = null;
  async load() {
    return this.saved;
  }
  async save(workspace: PersistedWorkspace) {
    this.saved = workspace;
  }
}

interface WarmCall {
  readonly provider: ProviderId;
  readonly model?: string;
  readonly effort?: string;
}

class RecordingGateway implements AgentGateway {
  endedSessions: string[] = [];
  warmed: WarmCall[] = [];

  async startTurn(
    _request: AgentTurnRequest,
    _onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {}
  subscribeSessionEvents(): void {}
  subscribeAgentInitiated(): void {}
  async readTerminalOutput(): Promise<null> {
    return null;
  }
  async cancelTurn(): Promise<void> {}
  async endSession(tabId: string): Promise<void> {
    this.endedSessions.push(tabId);
  }
  async warmSession(
    _tabId: string,
    provider: ProviderId,
    _projectPath: string,
    model?: string,
    effort?: string,
  ): Promise<void> {
    this.warmed.push({ provider, model, effort });
  }
  async listNativeSessions(): Promise<{ sessionId: string }[] | null> {
    return null;
  }
  async loadNativeSession(): Promise<{ replayed: boolean }> {
    return { replayed: true };
  }
  async respondPermission(): Promise<void> {}
  async respondQuestion(): Promise<void> {}
}

/** A Claude tab the user has driven away from every app default, mid
 *  conversation: it has spoken, and it has a session to resume. */
function setup() {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/a", projectDefaults(defaultSettings)),
  });
  store.dispatch({ type: "tab/providerChanged", tabId: "t1", provider: "claude" });
  store.dispatch({ type: "tab/modelChanged", tabId: "t1", model: "opus" });
  store.dispatch({ type: "tab/effortChanged", tabId: "t1", effort: "low" });
  store.dispatch({ type: "tab/modeChanged", tabId: "t1", mode: "debug" });
  store.dispatch({ type: "tab/permissionChanged", tabId: "t1", permission: "auto" });
  store.dispatch({
    type: "chat/sessionRecorded",
    tabId: "t1",
    provider: "claude",
    sessionId: "claude-session-1",
  });
  store.dispatch({
    type: "chat/messageAppended",
    tabId: "t1",
    message: userMessage("do a thing"),
  });
  // What Settings → Defaults says a fresh chat should run.
  store.dispatch({
    type: "settings/changed",
    patch: {
      defaultProvider: "codex",
      defaultMode: "plan",
      defaultPermission: "bypass",
      defaultModel: { codex: "gpt-6-astra" },
      defaultEffort: { codex: "high" },
    },
  });
  const gateway = new RecordingGateway();
  const workspaceStore = new FakeWorkspaceStore();
  return {
    store,
    gateway,
    workspaceStore,
    useCase: new StartNewChatOnDefaults(store, gateway, workspaceStore),
  };
}

const tabOf = (store: Store) => store.getState().tabs[0];

describe("StartNewChatOnDefaults", () => {
  let fixture: ReturnType<typeof setup>;

  beforeEach(() => {
    fixture = setup();
  });

  it("puts the tab back on every app default", async () => {
    await fixture.useCase.execute("t1");

    const { project } = tabOf(fixture.store);
    expect(project.provider).toBe("codex");
    expect(project.mode).toBe("plan");
    expect(project.permission).toBe("bypass");
    expect(project.model).toBe("gpt-6-astra");
    expect(project.effort).toBe("high");
  });

  it("clears the conversation", async () => {
    await fixture.useCase.execute("t1");

    expect(tabOf(fixture.store).messages).toEqual([]);
  });

  it("ends the outgoing provider's session and drops its resume id", async () => {
    // Dropped for the provider being left, not the one being adopted.
    await fixture.useCase.execute("t1");

    expect(fixture.gateway.endedSessions).toEqual(["t1"]);
    expect(tabOf(fixture.store).project.providerSessions.claude).toBeUndefined();
  });

  it("warms the agent the defaults name, not the one just retired", async () => {
    await fixture.useCase.execute("t1");

    expect(fixture.gateway.warmed).toEqual([
      { provider: "codex", model: "gpt-6-astra", effort: "high" },
    ]);
  });

  it("persists the reset, so it survives a restart", async () => {
    await fixture.useCase.execute("t1");

    expect(fixture.workspaceStore.saved?.projects[0].provider).toBe("codex");
    expect(fixture.workspaceStore.saved?.projects[0].model).toBe("gpt-6-astra");
  });

  it("discards a change deferred for the next chat — the defaults are the later word", async () => {
    // Both answer "what should the next chat run?"; the button is the
    // answer the user gave second.
    fixture.store.dispatch({
      type: "tab/specDeferred",
      tabId: "t1",
      model: "haiku",
      effort: "low",
    });

    await fixture.useCase.execute("t1");

    expect(tabOf(fixture.store).project.model).toBe("gpt-6-astra");
    expect(tabOf(fixture.store).pendingSpec).toBeUndefined();
  });

  it("leaves what the defaults do not cover alone", async () => {
    // A subtask scope and the tab's own name are not agent settings; a
    // new chat must not quietly widen or rename the tab.
    const before = tabOf(fixture.store).project;

    await fixture.useCase.execute("t1");

    const after = tabOf(fixture.store).project;
    expect(after.path).toBe(before.path);
    expect(after.subtask).toEqual(before.subtask);
    expect(after.mcpOverrides).toEqual(before.mcpOverrides);
  });

  it("does nothing while a turn is running", async () => {
    fixture.store.dispatch({ type: "chat/busyChanged", tabId: "t1", busy: true });

    await fixture.useCase.execute("t1");

    expect(fixture.gateway.endedSessions).toEqual([]);
    expect(tabOf(fixture.store).project.provider).toBe("claude");
    expect(tabOf(fixture.store).messages).toHaveLength(1);
  });
});
