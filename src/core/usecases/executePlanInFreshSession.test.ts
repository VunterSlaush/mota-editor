import { beforeEach, describe, expect, it } from "vitest";
import { approvalMessage, userMessage } from "../entities/message";
import { newProject } from "../entities/project";
import type {
  AgentGateway,
  AgentTurnEvent,
  AgentTurnRequest,
} from "../ports/agentGateway";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import {
  ExecutePlanInFreshSession,
  type FreshSessionSpec,
} from "./executePlanInFreshSession";

class FakeWorkspaceStore implements WorkspaceStore {
  saved: PersistedWorkspace | null = null;
  async load() {
    return this.saved;
  }
  async save(workspace: PersistedWorkspace) {
    this.saved = workspace;
  }
}

class RecordingGateway implements AgentGateway {
  responses: Array<{ requestId: string; optionId: string }> = [];
  cancelled: string[] = [];
  endedSessions: string[] = [];
  warmed: string[] = [];

  async startTurn(
    _request: AgentTurnRequest,
    _onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {}
  subscribeSessionEvents(): void {}
  subscribeAgentInitiated(): void {}
  async readTerminalOutput(): Promise<null> {
    return null;
  }
  async cancelTurn(tabId: string): Promise<void> {
    this.cancelled.push(tabId);
  }
  async endSession(tabId: string): Promise<void> {
    this.endedSessions.push(tabId);
  }
  async warmSession(tabId: string): Promise<void> {
    this.warmed.push(tabId);
  }
  async listNativeSessions(): Promise<{ sessionId: string }[] | null> {
    return null;
  }
  async loadNativeSession(): Promise<{ replayed: boolean }> {
    return { replayed: true };
  }
  async respondPermission(_tabId: string, requestId: string, optionId: string) {
    this.responses.push({ requestId, optionId });
  }
  async respondQuestion(): Promise<void> {}
}

const DEFAULTS = projectDefaults(defaultSettings);

const PLAN = "## Step 1\n\nRename `foo` to `bar`.";

const PLAN_OPTIONS = [
  { optionId: "acceptEdits", name: "Yes, auto-accept edits", kind: "allow_always" },
  { optionId: "plan", name: "No, keep planning", kind: "reject_once" },
];

const CODEX_SPEC: FreshSessionSpec = {
  provider: "codex",
  model: "gpt-5.6-sol",
  effort: "high",
  permission: "bypass",
};

/** A tab parked on a plan approval, as sendPrompt leaves it: the card is
 *  unanswered, the turn is not busy, and the conversation is live — a
 *  user has spoken and the provider has a session to resume. */
function planSetup(options: readonly { optionId: string; name: string; kind: string }[]) {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/a", { ...DEFAULTS, mode: "plan" }),
  });
  store.dispatch({
    type: "chat/sessionRecorded",
    tabId: "t1",
    provider: "claude",
    sessionId: "claude-session-1",
  });
  store.dispatch({
    type: "chat/messageAppended",
    tabId: "t1",
    message: userMessage("plan this"),
  });
  store.dispatch({
    type: "chat/messageAppended",
    tabId: "t1",
    message: approvalMessage("Ready to code?", {
      requestId: "p1",
      options,
      isPlan: true,
      planMarkdown: PLAN,
    }),
  });
  const gateway = new RecordingGateway();
  const workspaceStore = new FakeWorkspaceStore();
  const turns: Array<{ tabId: string; prompt: string; savedAtStart: boolean }> = [];
  const useCase = new ExecutePlanInFreshSession(
    store,
    gateway,
    workspaceStore,
    async (tabId, prompt) => {
      turns.push({ tabId, prompt, savedAtStart: workspaceStore.saved !== null });
    },
  );
  return { store, gateway, workspaceStore, turns, useCase };
}

const tabOf = (store: Store) => store.getState().tabs[0];

describe("ExecutePlanInFreshSession", () => {
  let fixture: ReturnType<typeof planSetup>;

  beforeEach(() => {
    fixture = planSetup(PLAN_OPTIONS);
  });

  it("declines the parked plan and stops the planning agent", async () => {
    // Left running, it would be a second agent working the same repo.
    await fixture.useCase.execute("t1", CODEX_SPEC);

    expect(fixture.gateway.responses).toEqual([{ requestId: "p1", optionId: "plan" }]);
    expect(fixture.gateway.cancelled).toEqual(["t1"]);
  });

  it("sends the plan as the only prompt of the new session", async () => {
    await fixture.useCase.execute("t1", CODEX_SPEC);

    expect(fixture.turns).toHaveLength(1);
    expect(fixture.turns[0].tabId).toBe("t1");
    expect(fixture.turns[0].prompt).toContain(PLAN);
  });

  it("switches provider, model, effort and permission, deferring nothing", async () => {
    // Mid-conversation is precisely where SelectModel would defer — but
    // the conversation it was protecting is being thrown away.
    await fixture.useCase.execute("t1", CODEX_SPEC);

    const { project } = tabOf(fixture.store);
    expect(project.provider).toBe("codex");
    expect(project.model).toBe("gpt-5.6-sol");
    expect(project.effort).toBe("high");
    expect(project.permission).toBe("bypass");
    expect(tabOf(fixture.store).pendingSpec).toBeUndefined();
  });

  it("keeps the chosen model over one deferred earlier in the conversation", async () => {
    // Ending the conversation applies a deferred spec; getting the order
    // wrong lets that stale model win.
    fixture.store.dispatch({
      type: "tab/specDeferred",
      tabId: "t1",
      model: "haiku",
      effort: "low",
    });

    await fixture.useCase.execute("t1", CODEX_SPEC);

    expect(tabOf(fixture.store).project.model).toBe("gpt-5.6-sol");
    expect(tabOf(fixture.store).project.effort).toBe("high");
  });

  it("leaves plan mode behind, so the fresh session implements the plan", async () => {
    await fixture.useCase.execute("t1", CODEX_SPEC);

    expect(tabOf(fixture.store).project.mode).toBe("agent");
  });

  it("ends the outgoing provider's session and drops its resume id", async () => {
    await fixture.useCase.execute("t1", CODEX_SPEC);

    expect(fixture.gateway.endedSessions).toEqual(["t1"]);
    expect(tabOf(fixture.store).project.providerSessions.claude).toBeUndefined();
  });

  it("clears the conversation, so the plan card is gone", async () => {
    await fixture.useCase.execute("t1", CODEX_SPEC);

    expect(tabOf(fixture.store).messages).toEqual([]);
  });

  it("does not pre-warm an agent the turn is about to start anyway", async () => {
    await fixture.useCase.execute("t1", CODEX_SPEC);

    expect(fixture.gateway.warmed).toEqual([]);
  });

  it("persists the new choice before the turn starts", async () => {
    await fixture.useCase.execute("t1", CODEX_SPEC);

    expect(fixture.turns[0].savedAtStart).toBe(true);
    expect(fixture.workspaceStore.saved?.projects[0].provider).toBe("codex");
  });

  it("does nothing while a turn is running", async () => {
    fixture.store.dispatch({ type: "chat/busyChanged", tabId: "t1", busy: true });

    await fixture.useCase.execute("t1", CODEX_SPEC);

    expect(fixture.turns).toEqual([]);
    expect(fixture.gateway.responses).toEqual([]);
    expect(tabOf(fixture.store).project.provider).toBe(DEFAULTS.provider);
  });

  it("hands over even when the card offered no way to decline", async () => {
    // Stopping the turn still releases the request, so the agent is
    // never left holding an unanswered card.
    const noDecline = planSetup([PLAN_OPTIONS[0]]);

    await noDecline.useCase.execute("t1", CODEX_SPEC);

    expect(noDecline.gateway.responses).toEqual([]);
    expect(noDecline.turns).toHaveLength(1);
  });

  it("falls back to the tab's plan when the card carries no text", async () => {
    const store = new Store();
    store.dispatch({ type: "tab/opened", project: newProject("t1", "/a", DEFAULTS) });
    store.dispatch({ type: "tab/planMarkdownUpdated", tabId: "t1", markdown: PLAN });
    const gateway = new RecordingGateway();
    const turns: string[] = [];
    const useCase = new ExecutePlanInFreshSession(
      store,
      gateway,
      new FakeWorkspaceStore(),
      async (_tabId, prompt) => {
        turns.push(prompt);
      },
    );

    await useCase.execute("t1", CODEX_SPEC);

    expect(turns).toHaveLength(1);
    expect(turns[0]).toContain(PLAN);
  });

  it("does nothing when there is no plan to hand over", async () => {
    const store = new Store();
    store.dispatch({ type: "tab/opened", project: newProject("t1", "/a", DEFAULTS) });
    const gateway = new RecordingGateway();
    const turns: string[] = [];
    const useCase = new ExecutePlanInFreshSession(
      store,
      gateway,
      new FakeWorkspaceStore(),
      async (_tabId, prompt) => {
        turns.push(prompt);
      },
    );

    await useCase.execute("t1", CODEX_SPEC);

    expect(turns).toEqual([]);
    expect(gateway.endedSessions).toEqual([]);
    expect(tabOf(store).project.provider).toBe(DEFAULTS.provider);
  });
});
