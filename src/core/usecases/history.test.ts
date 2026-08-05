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
import { SessionHistory } from "./history";

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
}

/** Gateway with scriptable native history. */
class FakeGateway implements AgentGateway {
  nativeSessions: { sessionId: string; title?: string; updatedAt?: string }[] | null =
    null;
  replay: AgentTurnEvent[] = [];

  async startTurn(_r: AgentTurnRequest, _e: (event: AgentTurnEvent) => void) {}
  async cancelTurn() {}
  async respondPermission() {}
  async respondQuestion() {}
  async endSession() {}
  async warmSession() {}
  async listNativeSessions() {
    if (!this.nativeSessions) throw new Error("native history unavailable");
    return this.nativeSessions;
  }
  async loadNativeSession(
    _request: unknown,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {
    this.replay.forEach(onEvent);
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

describe("SessionHistory", () => {
  it("prefers the agent's native session list", async () => {
    const { gateway, history } = setup();
    gateway.nativeSessions = [
      {
        sessionId: "abc-123",
        title: "Plan the feature",
        updatedAt: "2026-08-04T10:00:00Z",
      },
    ];

    const listing = await history.list("t1");

    expect(listing.native).toBe(true);
    expect(listing.sessions[0].id).toBe("abc-123");
    expect(listing.sessions[0].title).toBe("Plan the feature");
  });

  it("lists newest first and drops entries without a session id", async () => {
    const { gateway, history } = setup();
    gateway.nativeSessions = [
      { sessionId: "old", updatedAt: "2026-08-01T10:00:00Z" },
      // A malformed entry must not throw the whole list away.
      { sessionId: "", title: "broken" },
      { sessionId: "new", updatedAt: "2026-08-05T10:00:00Z" },
    ];

    const listing = await history.list("t1");

    expect(listing.sessions.map((s) => s.id)).toEqual(["new", "old"]);
  });

  it("falls back to the local store when the agent lists nothing", async () => {
    const { gateway, transcripts, history } = setup();
    gateway.nativeSessions = [];
    transcripts.transcripts.set("s1", {
      id: "s1",
      title: "old chat",
      savedAt: 1,
      provider: "claude",
      messages: [],
    });

    const listing = await history.list("t1");

    expect(listing.native).toBe(false);
    expect(listing.sessions[0].id).toBe("s1");
  });

  it("falls back to the local store when native history is unavailable", async () => {
    const { transcripts, history } = setup();
    transcripts.transcripts.set("s1", {
      id: "s1",
      title: "old chat",
      savedAt: 1,
      provider: "claude",
      messages: [],
    });

    const listing = await history.list("t1");

    expect(listing.native).toBe(false);
    expect(listing.sessions[0].id).toBe("s1");
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
