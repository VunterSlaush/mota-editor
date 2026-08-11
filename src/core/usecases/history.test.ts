import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
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
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { type HistoryListing, SessionHistory } from "./history";

class FakeTranscriptStore implements TranscriptStore {
  transcripts = new Map<string, PersistedTranscript>();
  planFiles = new Map<string, string>();
  async save(_p: string, t: PersistedTranscript) {
    this.transcripts.set(t.id, t);
  }
  async list(): Promise<TranscriptMeta[]> {
    return [...this.transcripts.values()].map((t) => ({
      id: t.id,
      title: t.title,
      savedAt: t.savedAt,
      provider: t.provider,
      messageCount: t.messages.length,
    }));
  }
  async load(_p: string, id: string): Promise<PersistedTranscript | null> {
    return this.transcripts.get(id) ?? null;
  }
  async remove(_p: string, id: string): Promise<void> {
    this.transcripts.delete(id);
  }
  async readPlanFile(_projectPath: string, path: string): Promise<string | null> {
    return this.planFiles.get(path) ?? null;
  }
  async listStats() {
    return [];
  }
}

/** Gateway with scriptable native history. */
class FakeGateway implements AgentGateway {
  /** Null = no live session to ask (the gateway never boots one). */
  nativeSessions: { sessionId: string; title?: string; updatedAt?: string }[] | null =
    null;
  listError?: string;
  listCalls = 0;
  replay: AgentTurnEvent[] = [];
  /** False = the agent attached via `session/resume`, no replay stream. */
  replayed = true;
  lastLoad?: { sessionId: string; preferResume?: boolean };
  ended: string[] = [];
  warmed: string[] = [];

  async startTurn(_r: AgentTurnRequest, _e: (event: AgentTurnEvent) => void) {}
  subscribeSessionEvents() {}
  subscribeAgentInitiated() {}
  async readTerminalOutput() {
    return null;
  }
  async cancelTurn() {}
  async respondPermission() {}
  async respondQuestion() {}
  async endSession(tabId: string) {
    this.ended.push(tabId);
  }
  async warmSession(tabId: string) {
    this.warmed.push(tabId);
  }
  async listNativeSessions() {
    this.listCalls += 1;
    if (this.listError) throw new Error(this.listError);
    return this.nativeSessions;
  }
  async loadNativeSession(
    request: { sessionId: string; preferResume?: boolean },
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<{ replayed: boolean }> {
    this.lastLoad = request;
    if (this.replayed) this.replay.forEach(onEvent);
    return { replayed: this.replayed };
  }
}

function setup() {
  const store = new Store();
  store.dispatch({ type: "tab/opened", project: newProject("t1", "/repo", DEFAULTS) });
  const transcripts = new FakeTranscriptStore();
  const gateway = new FakeGateway();
  return {
    store,
    transcripts,
    gateway,
    history: new SessionHistory(store, transcripts, gateway),
  };
}

const DEFAULTS = projectDefaults(defaultSettings);

/** Let the fire-and-forget background refresh run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A local transcript with just enough shape to list. */
function meta(id: string, savedAt: number): PersistedTranscript {
  return { id, title: `chat ${id}`, savedAt, provider: "claude", messages: [] };
}

describe("SessionHistory", () => {
  it("paints the local listing without ever calling the agent", async () => {
    const { transcripts, gateway, history } = setup();
    transcripts.transcripts.set("s1", meta("s1", 1));

    const listing = await history.list("t1");

    expect(listing.native).toBe(false);
    expect(listing.sessions.map((s) => s.id)).toEqual(["s1"]);
    expect(gateway.listCalls).toBe(0); // no refresh requested — no agent
  });

  it("resolves the local paint even while the native listing hangs", async () => {
    const { transcripts, gateway, history } = setup();
    transcripts.transcripts.set("s1", meta("s1", 1));
    // An agent mid-boot: the listing answer never comes.
    gateway.listNativeSessions = () => new Promise<never>(() => {});

    const listing = await history.list("t1", () => {});

    expect(listing.sessions.map((s) => s.id)).toEqual(["s1"]);
  });

  it("keeps the local paint when no live session exists to ask", async () => {
    const { transcripts, gateway, history } = setup();
    transcripts.transcripts.set("s1", meta("s1", 1));
    gateway.nativeSessions = null; // gateway: no live session, didn't ask

    let refreshed: HistoryListing | undefined;
    await history.list("t1", (listing) => (refreshed = listing));
    await settle();

    expect(refreshed).toBeUndefined();
  });

  it("merges the native listing in the background: native ids win, local-only stays", async () => {
    const { transcripts, gateway, history } = setup();
    transcripts.transcripts.set("shared", meta("shared", 500));
    transcripts.transcripts.set("local-only", meta("local-only", 300));
    gateway.nativeSessions = [
      { sessionId: "shared", title: "Shared", updatedAt: "2026-08-05T10:00:00Z" },
      // Created via the CLI, outside this app — must still appear.
      { sessionId: "cli-only", title: "From the CLI", updatedAt: "2026-08-04T10:00:00Z" },
    ];

    const refreshed = await new Promise<HistoryListing>((resolve) => {
      void history.list("t1", resolve);
    });

    expect(refreshed.native).toBe(true);
    const byId = new Map(refreshed.sessions.map((s) => [s.id, s]));
    expect(byId.get("shared")?.native).toBe(true); // opening truly resumes
    expect(byId.get("cli-only")?.native).toBe(true);
    expect(byId.get("local-only")?.native).toBe(false);
    // Our savedAt (last message) overlays the agent's updatedAt (last look).
    expect(byId.get("shared")?.savedAt).toBe(500);
  });

  it("lists newest first and drops entries without a session id", async () => {
    const { gateway, history } = setup();
    gateway.nativeSessions = [
      { sessionId: "old", updatedAt: "2026-08-01T10:00:00Z" },
      // A malformed entry must not throw the whole list away.
      { sessionId: "", title: "broken" },
      { sessionId: "new", updatedAt: "2026-08-05T10:00:00Z" },
    ];

    const refreshed = await new Promise<HistoryListing>((resolve) => {
      void history.list("t1", resolve);
    });

    expect(refreshed.sessions.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("surfaces a native failure only when there is nothing local to show", async () => {
    const { transcripts, gateway, history } = setup();
    gateway.listError = "agent broke";

    const empty = await new Promise<HistoryListing>((resolve) => {
      void history.list("t1", resolve);
    });
    expect(empty.error).toBe("agent broke");

    // With local sessions painted, the background failure stays silent.
    transcripts.transcripts.set("s1", meta("s1", 1));
    let refreshed: HistoryListing | undefined;
    await history.list("t1", (listing) => (refreshed = listing));
    await settle();
    expect(refreshed).toBeUndefined();
  });

  it("native open replays the conversation and marks it resumed", async () => {
    const { store, gateway, history } = setup();
    gateway.replay = [
      { kind: "userDelta", text: "plan the feature" },
      { kind: "assistantDelta", text: "Here is " },
      { kind: "assistantDelta", text: "the plan." },
      { kind: "tool", name: "read", detail: "Reading files" },
    ];

    await history.open("t1", "abc-123", true);

    const tab = store.getState().tabs[0];
    expect(tab.messages.map((m) => m.role)).toEqual([
      "user",
      "assistant",
      "tool",
      "info",
    ]);
    expect(tab.messages[1].text).toBe("Here is the plan.");
    expect(tab.messages[3].text).toContain("remembers");
    expect(tab.historySessionId).toBe("abc-123");
    expect(tab.busy).toBe(false);
  });

  it("replays thoughts, tool calls with final status, errors, and usage", async () => {
    const { store, gateway, history } = setup();
    gateway.replay = [
      { kind: "userDelta", text: "run the tests" },
      { kind: "thoughtDelta", text: "Let me check…" },
      {
        kind: "toolCall",
        toolCallId: "c1",
        toolKind: "execute",
        title: "npm test",
        status: "pending",
      },
      {
        kind: "toolCallUpdate",
        toolCallId: "c1",
        status: "completed",
        content: [{ type: "text", text: "42 passed" }],
      },
      { kind: "error", message: "one flaky retry", context: "agent-exited" },
      { kind: "usage", used: 1200, size: 200000 },
      { kind: "assistantDelta", text: "All green." },
    ];

    await history.open("t1", "abc-123", true);

    const tab = store.getState().tabs[0];
    expect(tab.messages.map((m) => m.role)).toEqual([
      "user",
      "thought",
      "tool",
      "error",
      "assistant",
      "info",
    ]);
    const tool = tab.messages[2];
    expect(tool.toolCall?.status).toBe("completed");
    expect(tool.toolCall?.content).toEqual([{ type: "text", text: "42 passed" }]);
    expect(tab.messages[3].error?.context).toBe("agent-exited");
    expect(tab.usage).toEqual({ used: 1200, size: 200000 });
  });

  it("startNew ends the backend session, resets state, and re-warms", async () => {
    const { store, gateway, history } = setup();
    store.dispatch({
      type: "chat/sessionRecorded",
      tabId: "t1",
      provider: "claude",
      sessionId: "old-session",
    });
    store.dispatch({ type: "tab/usageUpdated", tabId: "t1", used: 5, size: 10 });

    await history.startNew("t1");

    const tab = store.getState().tabs[0];
    expect(gateway.ended).toEqual(["t1"]);
    expect(gateway.warmed).toEqual(["t1"]);
    expect(tab.project.providerSessions.claude).toBeUndefined();
    expect(tab.usage).toBeUndefined();
    expect(tab.messages).toEqual([]);
  });

  it("lands a replayed session in one update, however long the conversation", async () => {
    const { store, gateway, history } = setup();
    gateway.replay = Array.from({ length: 40 }, (_, i) => ({
      kind: i % 2 === 0 ? "userDelta" : "assistantDelta",
      text: `line ${i}`,
    })) as AgentTurnEvent[];

    let updates = 0;
    store.subscribe(() => {
      updates += 1;
    });

    await history.open("t1", "abc-123", true);

    // cleared, busy on, the whole transcript, busy off — and nothing per
    // event, or the transcript builds on screen and the view chases the
    // bottom all the way down.
    expect(updates).toBe(4);
  });

  it("does not claim the session when the resume failed", async () => {
    const { store, gateway, history } = setup();
    gateway.loadNativeSession = async () => {
      throw new Error("session file is gone");
    };

    await history.open("t1", "abc-123", true);

    const tab = store.getState().tabs[0];
    expect(tab.historySessionId).toBeUndefined();
    expect(tab.messages.at(-1)?.text).toContain("session file is gone");
    expect(tab.busy).toBe(false);
  });

  it("prefers session/resume and paints from the local copy when nothing replays", async () => {
    const { store, transcripts, gateway, history } = setup();
    transcripts.transcripts.set("abc-123", {
      id: "abc-123",
      title: "old chat",
      savedAt: 5,
      provider: "claude",
      messages: [
        { id: "m1", role: "user", text: "plan it" },
        { id: "m2", role: "assistant", text: "done" },
      ],
      plan: [{ content: "step", priority: "high", status: "pending" }],
    });
    gateway.replayed = false; // the agent attached without a replay

    await history.open("t1", "abc-123", true);

    const tab = store.getState().tabs[0];
    expect(gateway.lastLoad?.preferResume).toBe(true);
    expect(tab.messages.map((m) => m.role)).toEqual(["user", "assistant", "info"]);
    expect(tab.messages.at(-1)?.text).toContain("remembers");
    expect(tab.plan).toHaveLength(1);
    expect(tab.historySessionId).toBe("abc-123");
    expect(tab.busy).toBe(false);
  });

  it("never asks for a resume without a local copy to paint from", async () => {
    const { gateway, history } = setup();
    gateway.replay = [{ kind: "userDelta", text: "plan the feature" }];

    await history.open("t1", "abc-123", true);

    // Resume skips the replay — without our own transcript the screen
    // would come back blank, so the full load must be requested.
    expect(gateway.lastLoad?.preferResume).toBe(false);
  });

  it("local open restores the plan by reading its FILE PATH from disk", async () => {
    const { store, transcripts, history } = setup();
    transcripts.planFiles.set("/home/u/.claude/plans/p.md", "# Plan\n\n1. Add the port");
    transcripts.transcripts.set("s1", {
      id: "s1",
      title: "old chat",
      savedAt: 123,
      provider: "claude",
      messages: [{ id: "m1", role: "user", text: "plan it" }],
      plan: [{ content: "Add the port", priority: "high", status: "pending" }],
      planFilePath: "/home/u/.claude/plans/p.md",
    });

    await history.open("t1", "s1", false);

    const tab = store.getState().tabs[0];
    expect(tab.plan).toHaveLength(1);
    expect(tab.planMarkdown).toContain("# Plan");
  });

  it("says so when the plan file no longer exists", async () => {
    const { store, transcripts, history } = setup();
    transcripts.transcripts.set("s1", {
      id: "s1",
      title: "old chat",
      savedAt: 123,
      provider: "claude",
      messages: [{ id: "m1", role: "user", text: "plan it" }],
      planFilePath: "/gone/p.md",
    });

    await history.open("t1", "s1", false);

    const infos = store.getState().tabs[0].messages.filter((m) => m.role === "info");
    expect(infos.some((m) => m.text.includes("no longer exists"))).toBe(true);
  });
});
