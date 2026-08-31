import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commandConfigKey } from "../entities/commandConfig";
import { newProject } from "../entities/project";
import type { SubagentInfo } from "../entities/subagent";
import { tabStatus } from "../entities/tabStatus";
import type { AgentCatalog } from "../ports/agentCatalog";
import type {
  AgentGateway,
  AgentTurnEvent,
  AgentTurnRequest,
} from "../ports/agentGateway";
import type {
  PersistedTranscript,
  TranscriptMeta,
  TranscriptStore,
} from "../ports/transcriptStore";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { ApplyCommandConfig } from "./applyCommandConfig";
import { ListSubagents } from "./listSubagents";
import { FOLLOWUP_SETTLE_MS, FOLLOWUP_TOOL_GRACE_MS, SendPrompt } from "./sendPrompt";
import { SelectEffort, SelectMode, SelectModel, SelectPermission } from "./switchTab";

/** Test double — a scripted agent, per the case study's in-memory gateways. */
class FakeAgentGateway implements AgentGateway {
  requests: AgentTurnRequest[] = [];
  script: AgentTurnEvent[] = [];
  failWith: string | null = null;
  /** An agent whose stale turn a cancel really does clear, so the retry
   *  after one goes through. */
  recoverAfterCancel = false;
  permissionResponses: Array<{ requestId: string; optionId: string }> = [];
  /** The last turn's event sink, kept so a test can deliver a late event. */
  lastOnEvent: ((event: AgentTurnEvent) => void) | null = null;

  async startTurn(
    request: AgentTurnRequest,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {
    if (this.failWith) throw new Error(this.failWith);
    this.requests.push(request);
    this.lastOnEvent = onEvent;
    this.script.forEach(onEvent);
  }

  subscribeSessionEvents(): void {}

  /** The agent-initiated lane's sink, so a test can play a follow-up. */
  agentInitiated: ((tabId: string, event: AgentTurnEvent) => void) | null = null;
  subscribeAgentInitiated(onEvent: (tabId: string, event: AgentTurnEvent) => void): void {
    this.agentInitiated = onEvent;
  }

  async readTerminalOutput(): Promise<null> {
    return null;
  }

  cancelled: string[] = [];
  async cancelTurn(tabId: string): Promise<void> {
    this.cancelled.push(tabId);
    if (this.recoverAfterCancel) this.failWith = null;
  }

  async respondQuestion(): Promise<void> {}

  async respondPermission(
    _tabId: string,
    requestId: string,
    optionId: string,
  ): Promise<void> {
    this.permissionResponses.push({ requestId, optionId });
  }

  async endSession(): Promise<void> {}
  warms = 0;
  async warmSession(): Promise<void> {
    this.warms += 1;
  }
  async listNativeSessions(): Promise<{ sessionId: string }[] | null> {
    return null;
  }
  async loadNativeSession(): Promise<{ replayed: boolean }> {
    return { replayed: true };
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

class FakeNotifications {
  calls: Array<{ projectName: string; providerName: string; tabActive: boolean }> = [];
  async turnCompleted(projectName: string, providerName: string, tabActive: boolean) {
    this.calls.push({ projectName, providerName, tabActive });
  }
  async show() {}
}

class FakeTranscriptStore implements TranscriptStore {
  saved: PersistedTranscript[] = [];
  /** What a previous run left on disk, by id. */
  stored = new Map<string, PersistedTranscript>();
  async save(_projectPath: string, transcript: PersistedTranscript) {
    this.saved.push(transcript);
    this.stored.set(transcript.id, transcript);
  }
  async list(): Promise<TranscriptMeta[]> {
    return [];
  }
  async keywords() {
    return [];
  }
  async listExternal() {
    return [];
  }
  async load(_projectPath: string, id: string): Promise<PersistedTranscript | null> {
    return this.stored.get(id) ?? null;
  }
  async remove(): Promise<void> {}
  async readPlanFile(_projectPath: string, _path: string): Promise<string | null> {
    return null;
  }
  async listStats() {
    return [];
  }
}

function setup(script: AgentTurnEvent[] = []) {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", DEFAULTS),
  });
  const gateway = new FakeAgentGateway();
  gateway.script = script;
  const workspace = new FakeWorkspaceStore();
  const transcripts = new FakeTranscriptStore();
  const notifications = new FakeNotifications();
  let counter = 0;
  const applyCommandConfig = new ApplyCommandConfig(
    store,
    new SelectMode(store, workspace),
    new SelectPermission(store, workspace),
    new SelectEffort(store, workspace, gateway),
    new SelectModel(store, workspace, gateway),
  );
  const agentCatalog = new FakeAgentCatalog();
  const useCase = new SendPrompt(
    store,
    gateway,
    workspace,
    transcripts,
    notifications,
    applyCommandConfig,
    () => `s${++counter}`,
    undefined,
    new ListSubagents(store, agentCatalog),
  );
  return { store, gateway, workspace, transcripts, notifications, agentCatalog, useCase };
}

class FakeAgentCatalog implements AgentCatalog {
  discovered: SubagentInfo[] = [
    { name: "mota-commit-push", description: "Commits", source: "user" },
  ];
  async listSubagents(): Promise<SubagentInfo[]> {
    return this.discovered;
  }
}

/** Configure a command to run in a sub-agent. */
function delegate(store: Store, command: string, agent: string) {
  store.dispatch({
    type: "settings/changed",
    patch: { commandConfigs: { [commandConfigKey("claude", command)]: { agent } } },
  });
}

const DEFAULTS = projectDefaults(defaultSettings);

const PLAN_APPROVAL: AgentTurnEvent = {
  kind: "permission",
  requestId: "p1",
  title: "Ready to code?",
  isPlan: true,
  planMarkdown: "# Plan\n\n1. Do the thing",
  options: [
    { optionId: "acceptEdits", name: "Yes", kind: "allow_always" },
    { optionId: "plan", name: "No, keep planning", kind: "reject_once" },
  ],
};

const TOOL_APPROVAL: AgentTurnEvent = {
  kind: "permission",
  requestId: "r1",
  title: "Run npm test",
  options: [
    { optionId: "allow", name: "Allow", kind: "allow_once" },
    { optionId: "reject", name: "Deny", kind: "reject_once" },
  ],
};

const tabOf = (store: Store) => store.getState().tabs[0];

/** Let fire-and-forget follow-up work (startNewChat, its `.then`) settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("a plan approval parks the turn", () => {
  it("leaves the tab idle so the user can answer in words", async () => {
    const { store, useCase } = setup([PLAN_APPROVAL]);
    await useCase.execute("t1", "plan it");

    expect(tabOf(store).busy).toBe(false);
  });

  it("keeps the tab busy for an ordinary tool approval", async () => {
    const { store, useCase } = setup([TOOL_APPROVAL]);
    await useCase.execute("t1", "run the tests");

    expect(tabOf(store).busy).toBe(true);
  });

  it("sending a message declines the plan and stops the agent", async () => {
    const { gateway, useCase } = setup([PLAN_APPROVAL]);
    await useCase.execute("t1", "plan it");
    gateway.script = [{ kind: "completed", isError: false }];
    await useCase.execute("t1", "actually, use Postgres");

    expect(gateway.permissionResponses).toEqual([{ requestId: "p1", optionId: "plan" }]);
    expect(gateway.cancelled).toEqual(["t1"]);
  });

  it("sends the message as a new prompt rather than queueing it", async () => {
    const { gateway, useCase } = setup([PLAN_APPROVAL]);
    await useCase.execute("t1", "plan it");
    gateway.script = [{ kind: "completed", isError: false }];
    await useCase.execute("t1", "actually, use Postgres");

    expect(gateway.requests.map((r) => r.prompt)).toEqual([
      "plan it",
      "actually, use Postgres",
    ]);
  });

  it("marks the plan card answered, so it stops looking clickable", async () => {
    const { store, useCase } = setup([PLAN_APPROVAL]);
    await useCase.execute("t1", "plan it");
    await useCase.execute("t1", "actually, use Postgres");

    const card = tabOf(store).messages.find((m) => m.approval?.requestId === "p1");
    expect(card?.approval?.resolvedOptionId).toBe("plan");
  });

  it("ignores the cancelled turn's completion instead of ending the new one", async () => {
    const { store, gateway, useCase } = setup([PLAN_APPROVAL]);
    await useCase.execute("t1", "plan it");
    // The stale turn's tail: captured while turn 1 ran, delivered late.
    const stale = gateway.lastOnEvent;
    gateway.script = [];
    await useCase.execute("t1", "actually, use Postgres");
    stale?.({ kind: "completed", isError: false, stopReason: "cancelled" });

    expect(tabOf(store).busy).toBe(true); // turn 2 is still running
  });
});

describe("SendPrompt with MCP servers", () => {
  it("hands the agent the servers switched on for its provider", async () => {
    const { store, gateway, useCase } = setup([{ kind: "completed", isError: false }]);
    store.dispatch({
      type: "settings/changed",
      patch: {
        mcpServers: [
          {
            id: "s1",
            name: "files",
            command: "npx",
            args: ["-y", "server-filesystem"],
            env: {},
            enabledFor: ["claude"],
          },
          {
            id: "s2",
            name: "search",
            command: "npx",
            args: [],
            env: {},
            enabledFor: ["gemini"],
          },
        ],
      },
    });

    await useCase.execute("t1", "Hello");

    expect(gateway.requests[0].mcpServers?.map((s) => s.name)).toEqual(["files"]);
  });
});

describe("SendPrompt with per-command settings", () => {
  it("sends the turn under the settings the command carries", async () => {
    const { store, gateway, useCase } = setup([{ kind: "completed", isError: false }]);
    store.dispatch({
      type: "settings/changed",
      patch: {
        commandConfigs: {
          "claude:/review": { mode: "plan", permission: "bypass", effort: "high" },
        },
      },
    });

    await useCase.execute("t1", "/review the diff");

    // The REQUEST must carry them, not just the store: a turn built from
    // the pre-command tab would run under the old settings.
    expect(gateway.requests[0].mode).toBe("plan");
    expect(gateway.requests[0].permission).toBe("bypass");
    expect(gateway.requests[0].effort).toBe("high");
  });

  it("leaves the tab configured that way afterwards", async () => {
    const { store, useCase } = setup([{ kind: "completed", isError: false }]);
    store.dispatch({
      type: "settings/changed",
      patch: { commandConfigs: { "claude:/review": { mode: "plan" } } },
    });

    await useCase.execute("t1", "/review");

    expect(store.getState().tabs[0].project.mode).toBe("plan");
  });

  it("does not re-warm the session when the tab already matches", async () => {
    // Effort changes respawn the agent (env-based over ACP). Running the
    // same command again with the setup already in place must not pay
    // that respawn a second time.
    const { store, gateway, useCase } = setup([{ kind: "completed", isError: false }]);
    store.dispatch({
      type: "settings/changed",
      patch: { commandConfigs: { "claude:/review": { effort: "high" } } },
    });

    await useCase.execute("t1", "/review the diff");
    const warmsAfterFirst = gateway.warms;
    await useCase.execute("t1", "/review again");

    expect(warmsAfterFirst).toBe(1);
    expect(gateway.warms).toBe(1);
  });

  it("keeps the session's effort once a conversation exists", async () => {
    // Applying a different effort means respawning the agent, and the
    // respawned session re-ingests the whole conversation on its next
    // turn. Saving those tokens outranks the command's preference: the
    // command runs under the session's current effort instead.
    const { store, gateway, useCase } = setup([
      { kind: "session", providerSessionId: "native-1" },
      { kind: "completed", isError: false },
    ]);
    store.dispatch({
      type: "settings/changed",
      patch: { commandConfigs: { "claude:/preview": { effort: "high" } } },
    });

    await useCase.execute("t1", "hello there");
    await useCase.execute("t1", "/preview");

    expect(store.getState().tabs[0].project.effort).not.toBe("high");
    expect(gateway.warms).toBe(0);
  });

  it("runs a command under the cheap model it pins", async () => {
    // The point of per-command routing: mechanical commands shouldn't
    // cost what a debugging session costs.
    const { gateway, store, useCase } = setup([{ kind: "completed", isError: false }]);
    store.dispatch({
      type: "settings/changed",
      patch: { commandConfigs: { "claude:/commit": { model: "haiku" } } },
    });

    await useCase.execute("t1", "/commit");

    expect(gateway.requests[0].model).toBe("haiku");
    expect(store.getState().tabs[0].project.model).toBe("haiku");
  });

  it("keeps the session's model once a conversation exists", async () => {
    // Same reasoning as effort: switching model mid-conversation
    // respawns the agent and re-sends everything at cache-write rates.
    // The command runs under the running model instead — and must NOT
    // leave a deferred change the user never asked for.
    const { gateway, store, useCase } = setup([
      { kind: "session", providerSessionId: "native-1" },
      { kind: "completed", isError: false },
    ]);
    store.dispatch({
      type: "settings/changed",
      patch: { commandConfigs: { "claude:/commit": { model: "haiku" } } },
    });

    await useCase.execute("t1", "hello there");
    const warmsBefore = gateway.warms;
    await useCase.execute("t1", "/commit");

    expect(store.getState().tabs[0].project.model).toBeUndefined();
    expect(store.getState().tabs[0].pendingSpec).toBeUndefined();
    expect(gateway.warms).toBe(warmsBefore);
  });

  it("leaves an unconfigured prompt alone", async () => {
    const { store, gateway, useCase } = setup([{ kind: "completed", isError: false }]);
    store.dispatch({
      type: "settings/changed",
      patch: { commandConfigs: { "claude:/review": { mode: "plan" } } },
    });

    await useCase.execute("t1", "what does /review do?");

    expect(gateway.requests[0].mode).toBe("agent");
    expect(store.getState().tabs[0].project.mode).toBe("agent");
  });
});

describe("SendPrompt auto-compaction", () => {
  /** Script a turn that reports the context over the ceiling. */
  const nearlyFull = (): AgentTurnEvent[] => [
    { kind: "usage", used: 95_000, size: 100_000 },
    { kind: "completed", isError: false },
  ];

  it("compacts on its own under the default policy", async () => {
    const { gateway, store, useCase } = setup(nearlyFull());

    await useCase.execute("t1", "Hello");

    expect(gateway.requests.map((r) => r.prompt)).toEqual(["Hello", "/compact"]);
    expect(store.getState().tabs[0].contextFullPercent).toBeUndefined();
  });

  it("asks instead of spending when the user wants the choice", async () => {
    // Compaction costs a full pass over the context; a new chat costs
    // nothing. Which is right is the user's call, so nothing is sent.
    const { gateway, store, useCase } = setup(nearlyFull());
    store.dispatch({ type: "settings/changed", patch: { autoCompact: "ask" } });

    await useCase.execute("t1", "Hello");

    expect(gateway.requests.map((r) => r.prompt)).toEqual(["Hello"]);
    expect(store.getState().tabs[0].contextFullPercent).toBe(95);
  });

  it("starts a new chat instead of compacting when asked to", async () => {
    // Length is what drives the bill, and only a new chat resets it.
    const { gateway, store, useCase } = setup(nearlyFull());
    store.dispatch({ type: "settings/changed", patch: { autoCompact: "newChat" } });

    await useCase.execute("t1", "Hello");
    await flush();

    expect(gateway.requests.map((r) => r.prompt)).toEqual(["Hello"]); // no /compact
    // The conversation is gone from the screen; only the notice remains.
    const tab = store.getState().tabs[0];
    expect(tab.messages.every((m) => m.role === "info")).toBe(true);
    expect(tab.project.providerSessions.claude).toBeUndefined();
  });

  it("saves the conversation to history BEFORE clearing the screen", async () => {
    // The safety property of the newChat policy: the one option that
    // wipes the screen must never be the one that loses the work.
    //
    // Two things protect it — the save is started before the policy runs,
    // and it reads the store synchronously, so the messages are captured
    // before anything clears them. Either alone is enough, which is why
    // this asserts the OUTCOME rather than the ordering: it fails only
    // when both have been undone, which is exactly when chats go missing.
    const { store, transcripts, useCase } = setup(nearlyFull());
    store.dispatch({ type: "settings/changed", patch: { autoCompact: "newChat" } });

    await useCase.execute("t1", "Hello");
    await flush();

    const saved = transcripts.saved.at(-1);
    expect(saved?.messages.some((m) => m.text === "Hello")).toBe(true);
  });

  it("leaves the explanation IN the new chat, where it survives the reset", async () => {
    // The notice must outlive the clear it is explaining. Said before the
    // reset it would be wiped by the very action it describes, and the
    // user would meet an empty chat with no reason for it.
    const { store, useCase } = setup(nearlyFull());
    store.dispatch({ type: "settings/changed", patch: { autoCompact: "newChat" } });

    await useCase.execute("t1", "Hello");
    await flush();

    const messages = store.getState().tabs[0].messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("info");
    expect(messages[0].text).toContain("saved in History");
  });

  it("does nothing at all when switched off", async () => {
    const { gateway, store, useCase } = setup(nearlyFull());
    store.dispatch({ type: "settings/changed", patch: { autoCompact: "off" } });

    await useCase.execute("t1", "Hello");

    expect(gateway.requests.map((r) => r.prompt)).toEqual(["Hello"]);
    expect(store.getState().tabs[0].contextFullPercent).toBeUndefined();
  });

  it("compacts when the user answers the question", async () => {
    const { gateway, store, useCase } = setup(nearlyFull());
    store.dispatch({ type: "settings/changed", patch: { autoCompact: "ask" } });
    await useCase.execute("t1", "Hello");

    await useCase.compactNow("t1");

    expect(gateway.requests.map((r) => r.prompt)).toEqual(["Hello", "/compact"]);
    expect(store.getState().tabs[0].contextFullPercent).toBeUndefined();
  });

  it("drops the question when the context comes back down", async () => {
    // A compaction or a new session answers it implicitly; leaving the
    // bar up would ask about a problem that no longer exists.
    const { store, useCase } = setup([
      { kind: "usage", used: 20_000, size: 100_000 },
      { kind: "completed", isError: false },
    ]);
    store.dispatch({ type: "settings/changed", patch: { autoCompact: "ask" } });
    store.dispatch({ type: "tab/contextFullChanged", tabId: "t1", percent: 95 });

    await useCase.execute("t1", "Hello");

    expect(store.getState().tabs[0].contextFullPercent).toBeUndefined();
  });

  it("never asks about the compact turn it just ran", async () => {
    const { store, useCase } = setup(nearlyFull());
    store.dispatch({ type: "settings/changed", patch: { autoCompact: "ask" } });

    await useCase.execute("t1", "/compact");

    expect(store.getState().tabs[0].contextFullPercent).toBeUndefined();
  });
});

describe("SendPrompt notices", () => {
  it("shows a session notice as an info row in the transcript", async () => {
    // An agent restart re-sends the whole conversation. Saying so where
    // it happens is what makes the charge in Insights explicable.
    const { store, useCase } = setup([
      { kind: "notice", message: "Agent restarted to apply a model change." },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "Hello");

    const info = store.getState().tabs[0].messages.filter((m) => m.role === "info");
    expect(info.map((m) => m.text)).toEqual(["Agent restarted to apply a model change."]);
  });
});

/** A conversation a previous run of the app left on disk. */
function earlierChat(providerSessionId: string): PersistedTranscript {
  return {
    id: "old-1",
    title: "the first prompt",
    savedAt: 1,
    provider: "claude",
    providerSessionId,
    messages: [{ id: "m1", role: "user", text: "the first prompt" }],
  };
}

/** The tab as a restart hands it back: no messages on screen, only a
 *  claim on the transcript it was writing to. */
function restoreTabWith(store: Store, historySessionId: string): void {
  store.dispatch({
    type: "workspace/restored",
    tabs: [
      {
        project: newProject("t1", "/work/alpha", DEFAULTS),
        messages: [],
        busy: false,
        queued: [],
        agentCommands: [],
        plan: [],
        shells: [],
        restoredHistorySessionId: historySessionId,
      },
    ],
    activeTabId: "t1",
    settings: defaultSettings,
  });
}

describe("SendPrompt transcript identity", () => {
  it("saves the provider's session id alongside the local one", async () => {
    // Without this the transcript cannot be matched to the vendor's own
    // records: `id` is a local UUID the provider has never heard of.
    const { transcripts, useCase } = setup([
      { kind: "session", providerSessionId: "claude-abc" },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "Hello");

    expect(transcripts.saved[0].providerSessionId).toBe("claude-abc");
    expect(transcripts.saved[0].id).not.toBe("claude-abc");
  });

  it("leaves it absent when the provider never reported one", async () => {
    const { transcripts, useCase } = setup([{ kind: "completed", isError: false }]);

    await useCase.execute("t1", "Hello");

    expect(transcripts.saved[0].providerSessionId).toBeUndefined();
  });

  it("rejoins the restored transcript when the agent is still in that conversation", async () => {
    // The frontend reloaded (every hot reload in dev) while the backend
    // session lived on: this is ONE conversation and must stay one row.
    const { store, transcripts, useCase } = setup([
      { kind: "session", providerSessionId: "claude-abc" },
      { kind: "completed", isError: false },
    ]);
    transcripts.stored.set("old-1", earlierChat("claude-abc"));
    restoreTabWith(store, "old-1");

    await useCase.execute("t1", "and now the tests");
    await flush(); // saveTranscript is fire-and-forget

    expect(transcripts.saved[0].id).toBe("old-1");
    expect(transcripts.saved[0].messages.map((m) => m.text)).toEqual([
      "the first prompt",
      "and now the tests",
    ]);
    expect(transcripts.saved[0].title).toBe("the first prompt");
    expect(store.getState().tabs[0].historySessionId).toBe("old-1");
  });

  it("starts a new transcript when the restored one belongs to another session", async () => {
    // A real restart boots a NEW agent session: appending to the old
    // transcript would merge two conversations and lose the first.
    const { store, transcripts, useCase } = setup([
      { kind: "session", providerSessionId: "claude-new" },
      { kind: "completed", isError: false },
    ]);
    transcripts.stored.set("old-1", earlierChat("claude-abc"));
    restoreTabWith(store, "old-1");

    await useCase.execute("t1", "carry on");
    await flush(); // saveTranscript is fire-and-forget

    expect(transcripts.saved[0].id).not.toBe("old-1");
    expect(transcripts.saved[0].messages.map((m) => m.text)).toEqual(["carry on"]);
    expect(transcripts.stored.get("old-1")?.messages).toHaveLength(1); // untouched
  });

  it("starts a new transcript when the tab has no session id to compare", async () => {
    const { store, transcripts, useCase } = setup([
      { kind: "completed", isError: false },
    ]);
    transcripts.stored.set("old-1", earlierChat("claude-abc"));
    restoreTabWith(store, "old-1");

    await useCase.execute("t1", "carry on");
    await flush(); // saveTranscript is fire-and-forget

    expect(transcripts.saved[0].id).not.toBe("old-1");
  });
});

describe("SendPrompt", () => {
  it("appends the user message and the assistant reply", async () => {
    const { store, useCase } = setup([
      { kind: "assistant", text: "Hi there" },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "Hello agent");

    const messages = store.getState().tabs[0].messages;
    expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(messages[1].text).toBe("Hi there");
    expect(store.getState().tabs[0].busy).toBe(false);
  });

  it("ignores empty prompts", async () => {
    const { store, gateway, useCase } = setup();
    await useCase.execute("t1", "   ");
    expect(gateway.requests).toHaveLength(0);
    expect(store.getState().tabs[0].messages).toHaveLength(0);
  });

  it("passes the tab's mode, permission, and attachments to the agent", async () => {
    const { store, gateway, useCase } = setup([{ kind: "completed", isError: false }]);
    store.dispatch({ type: "tab/modeChanged", tabId: "t1", mode: "plan" });
    store.dispatch({ type: "tab/permissionChanged", tabId: "t1", permission: "bypass" });

    await useCase.execute("t1", "plan the feature", ["/docs/spec.pdf"]);

    const request = gateway.requests[0];
    expect(request.mode).toBe("plan");
    expect(request.permission).toBe("bypass");
    expect(request.attachments).toEqual(["/docs/spec.pdf"]);
  });

  it("attachments alone are sendable, with a stand-in prompt", async () => {
    const { store, gateway, useCase } = setup([{ kind: "completed", isError: false }]);

    await useCase.execute("t1", "   ", ["/docs/spec.pdf"]);

    expect(gateway.requests[0].prompt).toBe("Please review the attached files.");
    const [message] = store.getState().tabs[0].messages;
    expect(message.attachments).toEqual(["/docs/spec.pdf"]);
  });

  it("passes the recorded session id so the conversation resumes", async () => {
    const { store, gateway, useCase } = setup([{ kind: "completed", isError: false }]);
    store.dispatch({
      type: "chat/sessionRecorded",
      tabId: "t1",
      provider: "claude",
      sessionId: "s-42",
    });

    await useCase.execute("t1", "continue please");

    expect(gateway.requests[0].resumeSessionId).toBe("s-42");
  });

  it("records the session id delivered on completion and persists it", async () => {
    const { store, workspace, useCase } = setup([
      { kind: "assistant", text: "done" },
      { kind: "completed", isError: false, providerSessionId: "s-99" },
    ]);

    await useCase.execute("t1", "do the thing");

    expect(store.getState().tabs[0].project.providerSessions.claude).toBe("s-99");
    expect(workspace.saved?.projects[0].providerSessions.claude).toBe("s-99");
  });

  it("shows tool activity as tool messages", async () => {
    const { store, useCase } = setup([
      { kind: "tool", name: "Bash", detail: "npm test" },
      { kind: "assistant", text: "tests pass" },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "run the tests");

    const roles = store.getState().tabs[0].messages.map((m) => m.role);
    expect(roles).toEqual(["user", "tool", "assistant"]);
  });

  it("tracks a tool call through its updates to one settled message", async () => {
    const { store, useCase } = setup([
      {
        kind: "toolCall",
        toolCallId: "c1",
        toolKind: "execute",
        title: "npm test",
        status: "pending",
      },
      { kind: "toolCallUpdate", toolCallId: "c1", status: "in_progress" },
      {
        kind: "toolCallUpdate",
        toolCallId: "c1",
        status: "completed",
        content: [{ type: "text", text: "42 passed" }],
        locations: [{ path: "/work/alpha/a.ts", line: 3 }],
      },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "run the tests");

    const tools = store.getState().tabs[0].messages.filter((m) => m.role === "tool");
    expect(tools).toHaveLength(1);
    expect(tools[0].toolCall?.status).toBe("completed");
    expect(tools[0].toolCall?.content).toEqual([{ type: "text", text: "42 passed" }]);
    expect(tools[0].toolCall?.locations).toEqual([{ path: "/work/alpha/a.ts", line: 3 }]);
  });

  it("an update for an unknown tool call changes nothing", async () => {
    const { store, useCase } = setup([
      { kind: "toolCallUpdate", toolCallId: "ghost", status: "completed" },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "hello");

    const roles = store.getState().tabs[0].messages.map((m) => m.role);
    expect(roles).toEqual(["user"]);
  });

  it("follows the agent's own mode switches, ignoring unknown ids", async () => {
    const { store, useCase } = setup([
      { kind: "modeChanged", modeId: "plan" },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "hello");
    expect(store.getState().tabs[0].project.mode).toBe("plan");

    const second = setup([
      { kind: "modeChanged", modeId: "some-exotic-mode" },
      { kind: "completed", isError: false },
    ]);
    await second.useCase.execute("t1", "hello");
    expect(second.store.getState().tabs[0].project.mode).toBe("agent");
  });

  it("says so when the reply was cut short by a token limit", async () => {
    const { store, useCase } = setup([
      { kind: "assistantDelta", text: "partial…" },
      { kind: "completed", isError: false, stopReason: "max_tokens" },
    ]);

    await useCase.execute("t1", "hello");

    const info = store.getState().tabs[0].messages.find((m) => m.role === "info");
    expect(info?.text).toContain("cut short");
  });

  it("tags a sign-in failure so the transcript can offer Sign in", async () => {
    const { store, useCase } = setup([
      {
        kind: "completed",
        isError: true,
        result: "Claude needs you to sign in again.",
        stopReason: "auth_required",
      },
    ]);

    await useCase.execute("t1", "hello");

    const error = store.getState().tabs[0].messages.find((m) => m.role === "error");
    expect(error?.error?.context).toBe("auth-required");
  });

  it("leaves an ordinary failure untagged — only sign-in has a known remedy", async () => {
    const { store, useCase } = setup([
      { kind: "completed", isError: true, result: "API Error: 529 Overloaded" },
    ]);

    await useCase.execute("t1", "hello");

    const error = store.getState().tabs[0].messages.find((m) => m.role === "error");
    expect(error?.text).toContain("529");
    expect(error?.error?.context).toBeUndefined();
  });

  it("a cancelled turn completes quietly without demanding attention", async () => {
    const { store, notifications, useCase } = setup([
      { kind: "completed", isError: false, stopReason: "cancelled" },
    ]);

    await useCase.execute("t1", "hello");

    expect(store.getState().tabs[0].busy).toBe(false);
    expect(notifications.calls).toHaveLength(0);
  });

  it("passes the tab's model to the agent", async () => {
    const { store, gateway, useCase } = setup([{ kind: "completed", isError: false }]);
    store.dispatch({ type: "tab/modelChanged", tabId: "t1", model: "opus" });

    await useCase.execute("t1", "hello");

    expect(gateway.requests[0].model).toBe("opus");
  });

  it("stores commands the agent advertises", async () => {
    const { store, useCase } = setup([
      {
        kind: "commands",
        commands: [{ name: "/compact", description: "Summarize the conversation" }],
      },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "hello");

    expect(store.getState().tabs[0].agentCommands[0].name).toBe("/compact");
  });

  it("streams deltas into one assistant bubble, split by tool activity", async () => {
    const { store, useCase } = setup([
      { kind: "assistantDelta", text: "Let me " },
      { kind: "assistantDelta", text: "check." },
      { kind: "tool", name: "read", detail: "Reading config" },
      { kind: "assistantDelta", text: "All good." },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "check the config");

    const messages = store.getState().tabs[0].messages;
    expect(messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "assistant",
    ]);
    expect(messages[1].text).toBe("Let me check.");
    expect(messages[3].text).toBe("All good.");
  });

  it("stores plan updates and streams thoughts as thought bubbles", async () => {
    const { store, useCase } = setup([
      { kind: "thoughtDelta", text: "Let me think" },
      { kind: "thoughtDelta", text: " about this." },
      {
        kind: "plan",
        entries: [{ content: "Read the code", priority: "high", status: "pending" }],
      },
      { kind: "assistantDelta", text: "Here's my plan." },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "plan the feature");

    const tab = store.getState().tabs[0];
    expect(tab.plan).toHaveLength(1);
    expect(tab.messages.map((m) => m.role)).toEqual(["user", "thought", "assistant"]);
    expect(tab.messages[1].text).toBe("Let me think about this.");
  });

  it("turns a permission request into an approval message", async () => {
    const { store, useCase } = setup([
      {
        kind: "permission",
        requestId: "9",
        title: "Run npm test",
        options: [
          { optionId: "allow", name: "Allow Once", kind: "allow_once" },
          { optionId: "reject", name: "Deny", kind: "reject_once" },
        ],
      },
    ]);

    await useCase.execute("t1", "run tests");

    const approval = store.getState().tabs[0].messages[1];
    expect(approval.role).toBe("approval");
    expect(approval.text).toBe("Run npm test");
    expect(approval.approval?.options).toHaveLength(2);
    expect(store.getState().tabs[0].busy).toBe(true); // still waiting
  });

  it("captures the plan markdown from a plan-mode approval request", async () => {
    const { store, useCase } = setup([
      {
        kind: "permission",
        requestId: "9",
        title: "Ready to code?",
        planMarkdown: "# My Plan\n\n1. Add the port\n2. Wire it",
        options: [{ optionId: "acceptEdits", name: "Yes", kind: "allow_once" }],
      },
    ]);

    await useCase.execute("t1", "plan this feature");

    expect(store.getState().tabs[0].planMarkdown).toContain("# My Plan");
  });

  it("cancels unanswered approvals when the turn completes", async () => {
    const { store, useCase } = setup([
      {
        kind: "permission",
        requestId: "9",
        title: "Run npm test",
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "run tests");

    const approval = store.getState().tabs[0].messages[1];
    expect(approval.approval?.cancelled).toBe(true);
  });

  it("reports a friendly error when the agent cannot start", async () => {
    const { store, gateway, useCase } = setup();
    gateway.failWith = "spawn ENOENT";

    await useCase.execute("t1", "hello?");

    const messages = store.getState().tabs[0].messages;
    expect(messages[1].role).toBe("error");
    expect(messages[1].text).toContain("Claude");
    expect(messages[1].text).toContain("PATH");
    expect(store.getState().tabs[0].busy).toBe(false);
  });

  it("stops a turn the backend still holds and sends the prompt anyway", async () => {
    // The tab looks idle here — a busy one would have queued the prompt
    // — so a backend that says otherwise has gone out of sync, and left
    // alone the tab can never be prompted again.
    const { store, gateway, useCase } = setup();
    gateway.failWith = "A turn is already running in this tab.";
    gateway.recoverAfterCancel = true;

    await useCase.execute("t1", "hello?");

    expect(gateway.cancelled).toEqual(["t1"]);
    expect(gateway.requests).toHaveLength(1);
    const messages = store.getState().tabs[0].messages;
    expect(messages.some((m) => m.role === "error")).toBe(false);
    expect(messages.some((m) => m.role === "info" && m.text.includes("stopped it"))).toBe(
      true,
    );
  });

  it("gives up rather than looping when the stale turn will not clear", async () => {
    const { store, gateway, useCase } = setup();
    gateway.failWith = "A turn is already running in this tab.";

    await useCase.execute("t1", "hello?");

    expect(gateway.cancelled).toEqual(["t1"]);
    const messages = store.getState().tabs[0].messages;
    expect(messages[messages.length - 1].role).toBe("error");
    expect(store.getState().tabs[0].busy).toBe(false);
  });

  it("flags a background tab and notifies when its turn completes", async () => {
    const { store, notifications, useCase } = setup([
      { kind: "completed", isError: false },
    ]);
    store.dispatch({
      type: "tab/opened",
      project: newProject("t2", "/work/beta", DEFAULTS),
    });
    // t2 is now active; run the turn in t1 (background).

    await useCase.execute("t1", "long refactor");

    expect(store.getState().tabs[0].attention).toBe(true);
    expect(notifications.calls).toEqual([
      { projectName: "alpha", providerName: "Claude", tabActive: false },
    ]);

    // Opening the tab acknowledges the attention flag.
    store.dispatch({ type: "tab/activated", tabId: "t1" });
    expect(store.getState().tabs[0].attention).toBe(false);
  });

  it("names the tab the way the user did when telling them a turn finished", async () => {
    const { store, notifications, useCase } = setup([
      { kind: "completed", isError: false },
    ]);
    store.dispatch({
      type: "tab/labelChanged",
      tabId: "t1",
      label: "auth rewrite",
    });
    store.dispatch({
      type: "tab/opened",
      project: newProject("t2", "/work/beta", DEFAULTS),
    });
    // t2 is now active; run the turn in t1 (background).

    await useCase.execute("t1", "long refactor");

    expect(notifications.calls).toEqual([
      { projectName: "auth rewrite", providerName: "Claude", tabActive: false },
    ]);
  });

  it("does not flag the active tab, and reports it as watched", async () => {
    const { store, notifications, useCase } = setup([
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "quick question");

    expect(store.getState().tabs[0].attention).toBeFalsy();
    expect(notifications.calls[0].tabActive).toBe(true);
  });

  it("tracks context usage and auto-compacts past the threshold, once", async () => {
    const { store, gateway, useCase } = setup([
      { kind: "usage", used: 180_000, size: 200_000 }, // 90% > threshold
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "big refactor");

    // The placeholder-size mark does not soften auto-compact: the agent's
    // numbers are still the best signal there is, and they crossed 90%.
    expect(store.getState().tabs[0].usage).toEqual({
      used: 180_000,
      size: 200_000,
      provisional: true,
    });
    // The follow-up compact turn was sent automatically...
    expect(gateway.requests.map((r) => r.prompt)).toEqual(["big refactor", "/compact"]);
    // ...with an explanatory info row, and did NOT re-trigger itself.
    const infos = store.getState().tabs[0].messages.filter((m) => m.role === "info");
    expect(infos.some((m) => m.text.includes("90% full"))).toBe(true);
  });

  it("does not compact below the threshold", async () => {
    const { gateway, useCase } = setup([
      { kind: "usage", used: 50_000, size: 200_000 },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "small task");

    expect(gateway.requests).toHaveLength(1);
  });

  it("estimates against the selected model's window when the agent reports none", async () => {
    // The denominator decides when auto-compact fires — a 200k guess for
    // a 1M-window model would compact at 18% of the real ceiling.
    const silent = setup([{ kind: "completed", isError: false }]);
    await silent.useCase.execute("t1", "no usage reported");
    expect(tabOf(silent.store).usage).toMatchObject({
      size: 1_000_000,
      estimated: true,
    });

    const haiku = setup([{ kind: "completed", isError: false }]);
    haiku.store.dispatch({ type: "tab/modelChanged", tabId: "t1", model: "haiku" });
    await haiku.useCase.execute("t1", "no usage reported");
    expect(tabOf(haiku.store).usage).toMatchObject({
      size: 200_000,
      estimated: true,
    });
  });

  it("keeps a provisional agent report through completion — no client estimate over it", async () => {
    // The agent's `used` is real accounting even while its `size` is the
    // adapter's placeholder; the char-count fallback must not replace it.
    const { store, useCase } = setup([
      { kind: "usage", used: 90_000, size: 200_000 },
      { kind: "completed", isError: false },
    ]);
    await useCase.execute("t1", "first turn on a fresh session");
    expect(tabOf(store).usage).toEqual({
      used: 90_000,
      size: 200_000,
      provisional: true,
    });
  });

  it("drops the provisional mark once the corrected window arrives", async () => {
    const { store, useCase } = setup([
      { kind: "usage", used: 90_000, size: 200_000 }, // adapter seed
      { kind: "usage", used: 92_000, size: 1_000_000 }, // authoritative
      { kind: "completed", isError: false },
    ]);
    await useCase.execute("t1", "first turn completes");
    expect(tabOf(store).usage).toEqual({ used: 92_000, size: 1_000_000 });
  });

  it("a real usage report always beats a prior estimate", async () => {
    const { store, gateway, useCase } = setup([{ kind: "completed", isError: false }]);
    await useCase.execute("t1", "first turn, agent silent");
    expect(tabOf(store).usage?.estimated).toBe(true);

    gateway.script = [
      { kind: "usage", used: 42_000, size: 500_000 },
      { kind: "completed", isError: false },
    ];
    await useCase.execute("t1", "second turn, agent reports");
    expect(tabOf(store).usage).toEqual({ used: 42_000, size: 500_000 });
  });

  it("saves the transcript to session history after a completed turn", async () => {
    const { store, transcripts, useCase } = setup([
      { kind: "assistant", text: "Done!" },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "refactor the login module please");
    await new Promise((resolve) => setTimeout(resolve, 0)); // saveTranscript is fire-and-forget

    expect(transcripts.saved).toHaveLength(1);
    expect(transcripts.saved[0].title).toBe("refactor the login module please");
    expect(transcripts.saved[0].projectPath).toBe("/work/alpha");
    expect(transcripts.saved[0].messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(store.getState().tabs[0].historySessionId).toBe(transcripts.saved[0].id);

    // A second turn re-saves the SAME session, not a new one.
    await useCase.execute("t1", "and add tests");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transcripts.saved[1].id).toBe(transcripts.saved[0].id);
  });

  it("queues a prompt sent while a turn is running", async () => {
    const { store, gateway, useCase } = setup(); // no "completed" → stays busy
    await useCase.execute("t1", "first");
    expect(store.getState().tabs[0].busy).toBe(true);

    await useCase.execute("t1", "second");

    expect(gateway.requests).toHaveLength(1);
    expect(store.getState().tabs[0].queued).toEqual([
      { prompt: "second", attachments: [] },
    ]);
  });

  it("delivers queued prompts in order as turns complete", async () => {
    const { store, gateway, useCase } = setup([{ kind: "completed", isError: false }]);
    // First send runs synchronously through "completed", so queue while
    // busy by scripting nothing first: simulate with a manual queue.
    store.dispatch({ type: "chat/busyChanged", tabId: "t1", busy: true });
    await useCase.execute("t1", "queued one");
    await useCase.execute("t1", "queued two");
    expect(store.getState().tabs[0].queued).toHaveLength(2);

    // The running turn finishes → the drain kicks in.
    store.dispatch({ type: "chat/busyChanged", tabId: "t1", busy: false });
    await useCase.execute("t1", "live prompt");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(gateway.requests.map((r) => r.prompt)).toEqual([
      "live prompt",
      "queued one",
      "queued two",
    ]);
    expect(store.getState().tabs[0].queued).toHaveLength(0);
  });

  it("removeQueued drops exactly the chosen message", async () => {
    const { store, useCase } = setup();
    store.dispatch({ type: "chat/busyChanged", tabId: "t1", busy: true });
    await useCase.execute("t1", "keep me");
    await useCase.execute("t1", "drop me");

    useCase.removeQueued("t1", 1);

    expect(store.getState().tabs[0].queued).toEqual([
      { prompt: "keep me", attachments: [] },
    ]);
  });
});

describe("SendPrompt turn meta", () => {
  it("stamps the user message with the turn's settings and command", async () => {
    const { store, useCase } = setup([{ kind: "completed", isError: false }]);
    store.dispatch({ type: "tab/modelChanged", tabId: "t1", model: "sonnet" });
    store.dispatch({ type: "tab/effortChanged", tabId: "t1", effort: "high" });

    await useCase.execute("t1", "/review src");
    await useCase.execute("t1", "plain prose prompt");

    const [first, second] = store
      .getState()
      .tabs[0].messages.filter((m) => m.role === "user");
    expect(first.turn).toMatchObject({
      mode: DEFAULTS.mode,
      permission: DEFAULTS.permission,
      model: "sonnet",
      effort: "high",
      command: "/review",
    });
    expect(first.turn?.sentAt).toBeGreaterThan(0);
    expect(second.turn?.command).toBeUndefined();
  });

  it("patches duration and the usage delta onto the prompt at completion", async () => {
    const { store, gateway, useCase } = setup([
      { kind: "usage", used: 1000, size: 200_000 },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "first");
    gateway.script = [
      { kind: "usage", used: 1600, size: 200_000 },
      { kind: "completed", isError: false },
    ];
    await useCase.execute("t1", "second");

    const users = store.getState().tabs[0].messages.filter((m) => m.role === "user");
    expect(users[0].turn?.tokens).toBe(1000); // from an empty context
    expect(users[1].turn?.tokens).toBe(600);
    expect(users[1].turn?.tokensEstimated).toBeUndefined();
    expect(users[1].turn?.durationMs).toBeGreaterThanOrEqual(0);
    expect(users[1].turn?.stopReason).toBeUndefined(); // end_turn is the quiet default
  });

  it("omits tokens on a negative delta and flags estimated endpoints", async () => {
    // (a) compaction shrank the context between the endpoints.
    const shrunk = setup([
      { kind: "usage", used: 5000, size: 200_000 },
      { kind: "completed", isError: false },
    ]);
    await shrunk.useCase.execute("t1", "first");
    shrunk.gateway.script = [
      { kind: "usage", used: 1000, size: 200_000 },
      { kind: "completed", isError: false },
    ];
    await shrunk.useCase.execute("t1", "second");
    const users = shrunk.store
      .getState()
      .tabs[0].messages.filter((m) => m.role === "user");
    expect(users[1].turn?.tokens).toBeUndefined();
    expect(users[1].turn?.durationMs).toBeGreaterThanOrEqual(0);

    // (b) the agent reported nothing — the client estimate taints the delta.
    const estimated = setup([{ kind: "completed", isError: false }]);
    await estimated.useCase.execute("t1", "no usage reported");
    const message = estimated.store
      .getState()
      .tabs[0].messages.find((m) => m.role === "user");
    expect(message?.turn?.tokens).toBeGreaterThan(0);
    expect(message?.turn?.tokensEstimated).toBe(true);
  });

  it("records the stop reason of a cancelled turn", async () => {
    const { store, useCase } = setup([
      { kind: "completed", isError: false, stopReason: "cancelled" },
    ]);

    await useCase.execute("t1", "abort me");

    const message = store.getState().tabs[0].messages.find((m) => m.role === "user");
    expect(message?.turn?.stopReason).toBe("cancelled");
    expect(message?.turn?.durationMs).toBeGreaterThanOrEqual(0);
  });
});

describe("a follow-up the agent starts on its own", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Play a turn, then let the agent come back with no prompt to answer. */
  async function afterATurn() {
    const made = setup([{ kind: "completed", isError: false }]);
    await made.useCase.execute("t1", "watch CI and tell me");
    const say = (event: AgentTurnEvent) => made.gateway.agentInitiated?.("t1", event);
    return { ...made, say };
  }

  it("puts what the agent said into the conversation", async () => {
    const { store, say } = await afterATurn();

    say({ kind: "assistant", text: "CI finished: 3 tests failed." });

    const last = tabOf(store).messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.text).toBe("CI finished: 3 tests failed.");
  });

  it("marks the tab busy while it runs, so Stop is reachable", async () => {
    const { store, say } = await afterATurn();

    say({ kind: "tool", name: "bash", detail: "gh run view" });

    expect(tabOf(store).busy).toBe(true);
  });

  it("lets the tab go idle again once the agent stops talking", async () => {
    const { store, say } = await afterATurn();

    say({ kind: "assistant", text: "CI is green." });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1000);

    expect(tabOf(store).busy).toBe(false);
  });

  it("stays busy while a tool it started is still running", async () => {
    const { store, say } = await afterATurn();

    say({ kind: "assistant", text: "Building." });
    say({
      kind: "toolCall",
      toolCallId: "c1",
      toolKind: "execute",
      title: "cargo build",
      status: "in_progress",
    });
    // A build says nothing for minutes. Silence here is the tool working,
    // not the agent finishing.
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1000);

    expect(tabOf(store).busy).toBe(true);
    expect(tabStatus(tabOf(store))).not.toBe("done");
  });

  it("goes idle once that tool reports back and the agent falls quiet", async () => {
    const { store, say } = await afterATurn();

    say({ kind: "assistant", text: "Building." });
    say({
      kind: "toolCall",
      toolCallId: "c1",
      toolKind: "execute",
      title: "cargo build",
      status: "in_progress",
    });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1000);
    say({ kind: "toolCallUpdate", toolCallId: "c1", status: "completed" });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1000);

    expect(tabOf(store).busy).toBe(false);
  });

  it("delivers what the user typed while the follow-up held the tab", async () => {
    const { gateway, useCase, say } = await afterATurn();

    say({ kind: "assistant", text: "CI failed." });
    await useCase.execute("t1", "fix it then");
    expect(gateway.requests).toHaveLength(1); // queued behind the follow-up

    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1000);

    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1].prompt).toBe("fix it then");
  });

  it("keeps its hands off the busy flag when a real turn started meanwhile", async () => {
    const { store, gateway, useCase, say } = await afterATurn();

    say({ kind: "assistant", text: "CI failed." });
    gateway.script = []; // a turn that does not finish on its own
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1000);
    await useCase.execute("t1", "fix it then");
    expect(tabOf(store).busy).toBe(true);

    // The follow-up's own settle must not mark that running turn idle.
    say({ kind: "assistant", text: "one more thing" });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1000);

    expect(tabOf(store).busy).toBe(true);
  });

  it("shows an approval it asks for, and answers it", async () => {
    const { store, gateway, say } = await afterATurn();

    say(TOOL_APPROVAL);
    const approval = tabOf(store).messages.at(-1);
    expect(approval?.approval?.requestId).toBe("r1");

    await gateway.respondPermission("t1", "r1", "allow");
    expect(gateway.permissionResponses).toEqual([{ requestId: "r1", optionId: "allow" }]);
  });

  it("gets the user's eyes on it and saves it once the agent goes quiet", async () => {
    const { transcripts, notifications, say } = await afterATurn();
    const savedByTheTurn = transcripts.saved.length;

    say({ kind: "assistant", text: "CI is green." });
    const notifiedByTheTurn = notifications.calls.length;
    // Nothing yet: the agent may still be mid-sentence.
    expect(transcripts.saved.length).toBe(savedByTheTurn);

    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1000);

    expect(notifications.calls.length).toBe(notifiedByTheTurn + 1);
    const saved = transcripts.saved.at(-1);
    expect(transcripts.saved.length).toBe(savedByTheTurn + 1);
    expect(saved?.messages.at(-1)?.text).toBe("CI is green.");
  });

  it("stays quiet for a stretch that only reported token usage", async () => {
    const { notifications, transcripts, say } = await afterATurn();
    const before = {
      notified: notifications.calls.length,
      saved: transcripts.saved.length,
    };

    say({ kind: "usage", used: 1000, size: 200000 });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1000);

    expect(notifications.calls.length).toBe(before.notified);
    expect(transcripts.saved.length).toBe(before.saved);
  });

  /**
   * The gaps measured inside one real autonomous cycle, driving the ACP
   * adapter directly (a background `sleep`, then the follow-up its
   * completion triggers): the cycle opens by reading the task's output
   * file, and the model's think time between a tool result and its next
   * word cleared 2s twice. At the original 2s settle each of those gaps
   * ended the stretch early — three notifications and three saves for one
   * follow-up, and a queued prompt free to drain into the middle of it.
   */
  it("rides out the think-time gaps inside one real cycle", async () => {
    const { store, notifications, transcripts, say } = await afterATurn();
    const before = {
      notified: notifications.calls.length,
      saved: transcripts.saved.length,
    };

    say({
      kind: "toolCall",
      toolCallId: "c1",
      toolKind: "read",
      title: "Read File",
      status: "pending",
    });
    await vi.advanceTimersByTimeAsync(2400);
    say({ kind: "toolCallUpdate", toolCallId: "c1", status: "completed" });
    await vi.advanceTimersByTimeAsync(2700);
    say({ kind: "assistant", text: "It finished. Exit code 0, output: CI-DONE." });

    // One unbroken stretch: still busy, and nothing announced yet.
    expect(tabOf(store).busy).toBe(true);
    expect(notifications.calls.length).toBe(before.notified);

    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1000);

    expect(tabOf(store).busy).toBe(false);
    expect(notifications.calls.length).toBe(before.notified + 1);
    expect(transcripts.saved.length).toBe(before.saved + 1);
  });

  it("holds a queued prompt until the whole cycle is done, not the first gap", async () => {
    const { gateway, useCase, say } = await afterATurn();

    say({
      kind: "toolCall",
      toolCallId: "c1",
      toolKind: "read",
      title: "Read File",
      status: "pending",
    });
    await useCase.execute("t1", "and then deploy");
    expect(gateway.requests).toHaveLength(1);

    // The 2.4s gap the real cycle has here must not release it.
    await vi.advanceTimersByTimeAsync(2400);
    say({ kind: "toolCallUpdate", toolCallId: "c1", status: "completed" });
    say({ kind: "assistant", text: "It finished." });
    expect(gateway.requests).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1000);

    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1].prompt).toBe("and then deploy");
  });

  it("releases a queued prompt even if a tool never reports back", async () => {
    const { store, gateway, useCase, say } = await afterATurn();

    say({
      kind: "toolCall",
      toolCallId: "c1",
      toolKind: "execute",
      title: "cargo build",
      status: "in_progress",
    });
    await useCase.execute("t1", "and then deploy");

    // Waiting on an open tool is bounded: a stretch that never settled
    // would hold this prompt forever, and the Stop that frees the tab
    // discards it.
    await vi.advanceTimersByTimeAsync(FOLLOWUP_TOOL_GRACE_MS + FOLLOWUP_SETTLE_MS + 1000);

    expect(gateway.requests).toHaveLength(2);
    expect(gateway.requests[1].prompt).toBe("and then deploy");
    expect(tabOf(store).busy).toBe(false);
  });

  it("ignores a follow-up for a tab that is no longer open", async () => {
    const { store, gateway } = await afterATurn();

    expect(() =>
      gateway.agentInitiated?.("gone", { kind: "assistant", text: "hello?" }),
    ).not.toThrow();
    expect(tabOf(store).messages.some((m) => m.text === "hello?")).toBe(false);
  });

  it("streams a follow-up's deltas into one message, like any other reply", async () => {
    const { store, say } = await afterATurn();

    say({ kind: "assistantDelta", text: "CI " });
    say({ kind: "assistantDelta", text: "is green." });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1000);

    const last = tabOf(store).messages.at(-1);
    expect(last?.role).toBe("assistant");
    expect(last?.text).toBe("CI is green.");
  });
});

describe("/clear", () => {
  it("never reaches the agent", async () => {
    // The whole point of handling it here: a provider that has no such
    // command would take the slash text for an ordinary prompt.
    const { gateway, useCase } = setup([{ kind: "completed", isError: false }]);

    await useCase.execute("t1", "Hello");
    await useCase.execute("t1", "/clear");
    await flush();

    expect(gateway.requests.map((r) => r.prompt)).toEqual(["Hello"]);
  });

  it("empties the transcript and drops the resumable session", async () => {
    const { store, useCase } = setup([{ kind: "completed", isError: false }]);

    await useCase.execute("t1", "Hello");
    await useCase.execute("t1", "/clear");
    await flush();

    const tab = store.getState().tabs[0];
    expect(tab.messages.some((m) => m.text === "Hello")).toBe(false);
    // Left behind, the old session id would resume the chat just cleared.
    expect(tab.project.providerSessions.claude).toBeUndefined();
  });

  it("says so IN the new chat, where the message survives the reset", async () => {
    const { store, useCase } = setup([{ kind: "completed", isError: false }]);

    await useCase.execute("t1", "Hello");
    await useCase.execute("t1", "/clear");
    await flush();

    const tab = store.getState().tabs[0];
    expect(tab.messages.every((m) => m.role === "info")).toBe(true);
    expect(tab.messages.at(-1)?.text).toContain("History");
  });

  it("saves the conversation before wiping it from the screen", async () => {
    // Same safety property the newChat policy has: the action that
    // empties the screen must never be the one that loses the work.
    const { store, transcripts, useCase } = setup([
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "Hello");
    await useCase.execute("t1", "/clear");
    await flush();

    expect(transcripts.saved.at(-1)?.messages.some((m) => m.text === "Hello")).toBe(true);
    expect(store.getState().tabs[0].messages.some((m) => m.text === "Hello")).toBe(false);
  });
});

describe("SendPrompt — handing a command to a sub-agent", () => {
  it("sends the typed text plus the agent, and keeps the typed text in the transcript", async () => {
    const { store, gateway, useCase } = setup();
    delegate(store, "/commit-push", "mota-commit-push");

    await useCase.execute("t1", "/commit-push fix the parser");

    expect(gateway.requests[0].delegateTo).toBe("mota-commit-push");
    // The adapter splits the command from its arguments to compose the
    // provider's own mention, so the typed text is what it needs.
    expect(gateway.requests[0].prompt).toBe("/commit-push fix the parser");
    const messages = store.getState().tabs[0].messages;
    expect(messages[0].text).toBe("/commit-push fix the parser");
  });

  it("records the sub-agent on the turn, so the saving can be measured later", async () => {
    const { store, useCase } = setup();
    delegate(store, "/commit-push", "mota-commit-push");

    await useCase.execute("t1", "/commit-push");

    // Insights compares a command's delegated runs against its in-chat
    // ones. Without this stamp the two are indistinguishable and the
    // Commands screen has nothing to report.
    const sent = store.getState().tabs[0].messages.find((m) => m.role === "user");
    expect(sent?.turn?.agent).toBe("mota-commit-push");
    expect(sent?.turn?.command).toBe("/commit-push");
  });

  it("leaves the turn unstamped when the command ran in the chat", async () => {
    const { store, useCase } = setup();

    await useCase.execute("t1", "/commit-push");

    const sent = store.getState().tabs[0].messages.find((m) => m.role === "user");
    expect(sent?.turn?.agent).toBeUndefined();
  });

  it("says out loud that the work went elsewhere", async () => {
    const { store, useCase } = setup();
    delegate(store, "/commit-push", "mota-commit-push");

    await useCase.execute("t1", "/commit-push");

    // The child's report arrives as a tool row, which the transcript
    // hides while Verbose is off — without this the turn looks empty.
    const notice = store.getState().tabs[0].messages.find((m) => m.role === "info");
    expect(notice?.text).toContain("mota-commit-push");
  });

  it("carries recent conversation so 'this' still means something", async () => {
    const { store, gateway, useCase } = setup([{ kind: "completed", isError: false }]);
    await useCase.execute("t1", "the parser drops escapes");
    delegate(store, "/commit-push", "mota-commit-push");

    await useCase.execute("t1", "/commit-push");

    expect(gateway.requests[1].handoff).toContain("the parser drops escapes");
  });

  it("does not delegate a command with no sub-agent configured", async () => {
    const { gateway, useCase } = setup();
    await useCase.execute("t1", "/commit-push");
    expect(gateway.requests[0].delegateTo).toBeUndefined();
    expect(gateway.requests[0].handoff).toBeUndefined();
  });

  it("refuses, loudly and before spending anything, when the agent is gone", async () => {
    const { store, gateway, agentCatalog, useCase } = setup();
    agentCatalog.discovered = [];
    delegate(store, "/commit-push", "mota-commit-push");

    await useCase.execute("t1", "/commit-push");

    // Silence here would be the one outcome that turns this feature into
    // a bill: the mention is dropped without error and the command runs
    // inline, costing MORE than not delegating at all.
    expect(gateway.requests).toHaveLength(0);
    const messages = store.getState().tabs[0].messages;
    expect(messages[0].text).toBe("/commit-push");
    expect(messages[1].role).toBe("error");
    expect(messages[1].text).toContain("mota-commit-push");
    expect(store.getState().tabs[0].busy).toBe(false);
  });

  it("never delegates compaction, whatever the settings say", async () => {
    const { store, gateway, useCase } = setup();
    delegate(store, "/compact", "mota-commit-push");

    await useCase.execute("t1", "/compact");

    // Compacting in a child would free nothing here while the tab kept
    // growing — and auto-compact sends this command itself.
    expect(gateway.requests[0].delegateTo).toBeUndefined();
  });

  it("never delegates a command Mota answers itself", async () => {
    const { store, gateway, useCase } = setup();
    delegate(store, "/clear", "mota-commit-push");

    await useCase.execute("t1", "/clear");

    expect(gateway.requests).toHaveLength(0);
    expect(store.getState().tabs[0].messages.some((m) => m.role === "error")).toBe(false);
  });

  it("does not read another provider's setting", async () => {
    const { store, gateway, useCase } = setup();
    store.dispatch({
      type: "settings/changed",
      patch: {
        commandConfigs: {
          [commandConfigKey("codex", "/commit-push")]: { agent: "mota-commit-push" },
        },
      },
    });

    await useCase.execute("t1", "/commit-push");

    expect(gateway.requests[0].delegateTo).toBeUndefined();
  });
});
