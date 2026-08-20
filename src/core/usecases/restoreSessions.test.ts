import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../entities/message";
import type { ProviderId } from "../entities/provider";
import type { AgentGateway } from "../ports/agentGateway";
import type { PersistedTranscript, TranscriptStore } from "../ports/transcriptStore";
import type { TabState } from "../state/appState";
import { Store } from "../state/store";
import { restoreSessions } from "./restoreSessions";

class FakeTranscriptStore {
  constructor(private readonly transcript: PersistedTranscript | null) {}
  loaded: { path: string; id: string }[] = [];
  async load(path: string, id: string): Promise<PersistedTranscript | null> {
    this.loaded.push({ path, id });
    return this.transcript;
  }
  async readPlanFile(): Promise<string | null> {
    return null;
  }
}

class FakeAgentGateway {
  warmed: string[] = [];
  loads: { tabId: string; sessionId: string; preferResume?: boolean }[] = [];
  constructor(private readonly refuse = false) {}

  async warmSession(tabId: string): Promise<void> {
    this.warmed.push(tabId);
  }

  async loadNativeSession(request: {
    tabId: string;
    sessionId: string;
    preferResume?: boolean;
  }): Promise<{ replayed: boolean }> {
    this.loads.push(request);
    if (this.refuse) throw new Error("no such session");
    return { replayed: false };
  }
}

function tabWith(claim: string | undefined, provider: ProviderId = "claude"): TabState {
  return {
    project: {
      id: "t1",
      path: "/work/alpha",
      name: "alpha",
      provider,
      mode: "agent",
      permission: "manual",
      verbose: true,
      providerSessions: { [provider]: "agent-abc" },
    },
    messages: [],
    restoredHistorySessionId: claim,
    busy: false,
    queued: [],
    agentCommands: [],
    plan: [],
    shells: [],
  };
}

const SAVED: ChatMessage[] = [
  { id: "m1", role: "user", text: "rename the port" },
  { id: "m2", role: "assistant", text: "done" },
];

function transcript(overrides: Partial<PersistedTranscript> = {}): PersistedTranscript {
  return {
    id: "old-1",
    title: "rename the port",
    savedAt: 1,
    provider: "claude",
    projectPath: "/work/alpha",
    providerSessionId: "agent-abc",
    messages: SAVED,
    ...overrides,
  };
}

function storeWith(tab: TabState): Store {
  const store = new Store();
  store.dispatch({
    type: "workspace/restored",
    tabs: [tab],
    activeTabId: tab.project.id,
    settings: store.getState().settings,
  });
  return store;
}

async function run(
  tab: TabState,
  transcripts: PersistedTranscript | null,
  refuse = false,
) {
  const store = storeWith(tab);
  const transcriptStore = new FakeTranscriptStore(transcripts);
  const agentGateway = new FakeAgentGateway(refuse);
  await restoreSessions(
    store,
    transcriptStore as unknown as TranscriptStore,
    agentGateway as unknown as AgentGateway,
  );
  return { state: store.getState(), transcriptStore, agentGateway };
}

describe("restoreSessions", () => {
  it("reopens the tab on the conversation it was in, not an empty chat", async () => {
    const { state } = await run(tabWith("old-1"), transcript());

    const tab = state.tabs[0];
    expect(tab.messages.map((m) => m.text)).toEqual([
      "rename the port",
      "done",
      // The outcome of the rejoin, appended after the paint.
      expect.stringContaining("Picked up where you left off"),
    ]);
    // The claim is a fact now: the next save appends to this transcript
    // instead of cutting the conversation into a second history entry.
    expect(tab.historySessionId).toBe("old-1");
    expect(tab.restoredHistorySessionId).toBeUndefined();
  });

  it("asks the agent to take the conversation back, without a replay", async () => {
    const { agentGateway } = await run(tabWith("old-1"), transcript());

    expect(agentGateway.loads).toEqual([
      expect.objectContaining({
        tabId: "t1",
        // The AGENT's id for the conversation, never our transcript's.
        sessionId: "agent-abc",
        // We just painted it, so it need not be streamed back to us.
        preferResume: true,
      }),
    ]);
  });

  it("keeps the transcript on screen when the agent cannot take it back", async () => {
    const { state, agentGateway } = await run(tabWith("old-1"), transcript(), true);

    const tab = state.tabs[0];
    expect(tab.messages.map((m) => m.text)).toEqual([
      "rename the port",
      "done",
      expect.stringContaining("the agent starts fresh"),
    ]);
    // A refused resume still leaves a session to send the next prompt to.
    expect(agentGateway.warmed).toEqual(["t1"]);
    // And the conversation keeps writing to the transcript it came from,
    // rather than forking a duplicate of itself under a new id.
    expect(tab.historySessionId).toBe("old-1");
  });

  it("never asks a provider that cannot resume", async () => {
    const { state, agentGateway } = await run(
      tabWith("old-1", "gemini"),
      transcript({ provider: "gemini" }),
    );

    expect(agentGateway.loads).toEqual([]);
    expect(agentGateway.warmed).toEqual(["t1"]);
    expect(state.tabs[0].messages.at(-1)?.text).toContain("the agent starts fresh");
  });

  it("just warms a tab that has no conversation to come back to", async () => {
    const { state, transcriptStore, agentGateway } = await run(tabWith(undefined), null);

    expect(transcriptStore.loaded).toEqual([]);
    expect(agentGateway.warmed).toEqual(["t1"]);
    expect(state.tabs[0].messages).toEqual([]);
  });

  it("starts a new chat when the transcript the tab claimed is gone", async () => {
    const { state, agentGateway } = await run(tabWith("old-1"), null);

    expect(agentGateway.loads).toEqual([]);
    expect(agentGateway.warmed).toEqual(["t1"]);
    expect(state.tabs[0].messages).toEqual([]);
    // Still only a claim — nothing proved it points at anything.
    expect(state.tabs[0].restoredHistorySessionId).toBe("old-1");
  });

  it("leaves no startup stage showing once the rejoin has settled", async () => {
    const { state } = await run(tabWith("old-1"), transcript());
    expect(state.tabs[0].sessionStage).toBeUndefined();
  });

  it("does not stack up a note per launch in the conversation", async () => {
    // The transcript is saved with whatever is on screen, so the note
    // the LAST launch appended comes back with it. Painting it and then
    // adding today's would grow the chat by a line every time the app
    // is opened.
    const alreadyNoted = transcript({
      messages: [
        ...SAVED,
        {
          id: "m3",
          role: "info",
          text: "Picked up where you left off — the agent remembers this conversation.",
        },
      ],
    });

    const { state } = await run(tabWith("old-1"), alreadyNoted);

    expect(
      state.tabs[0].messages.filter((m) => m.text.startsWith("Picked up where")),
    ).toHaveLength(1);
  });
});
