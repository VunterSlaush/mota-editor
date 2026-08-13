import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type {
  AgentGateway,
  AgentTurnEvent,
  AgentTurnRequest,
} from "../ports/agentGateway";
import type {
  ExternalSessionMeta,
  PersistedTranscript,
  TranscriptMeta,
  TranscriptStore,
} from "../ports/transcriptStore";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import {
  type HistoryItem,
  type HistoryListing,
  SessionHistory,
  type WorktreeAccess,
} from "./history";
import type { WorktreeItem } from "./worktrees";

class FakeTranscriptStore implements TranscriptStore {
  transcripts = new Map<string, PersistedTranscript>();
  planFiles = new Map<string, string>();
  /** The vendor's own store, as `list_external_sessions` reports it. */
  external: ExternalSessionMeta[] = [];
  externalCalls = 0;
  async save(_p: string, t: PersistedTranscript) {
    this.transcripts.set(t.id, t);
  }
  /** Transcripts belonging to another checkout, by that folder's path. */
  elsewhere = new Map<string, TranscriptMeta[]>();
  removed: Array<{ path: string; id: string }> = [];
  async list(projectPath: string): Promise<TranscriptMeta[]> {
    const other = this.elsewhere.get(projectPath);
    if (other) return other;
    return [...this.transcripts.values()].map((t) => ({
      id: t.id,
      title: t.title,
      savedAt: t.savedAt,
      provider: t.provider,
      providerSessionId: t.providerSessionId,
      messageCount: t.messages.length,
    }));
  }
  async listExternal(): Promise<ExternalSessionMeta[]> {
    this.externalCalls += 1;
    return this.external;
  }
  async load(_p: string, id: string): Promise<PersistedTranscript | null> {
    return this.transcripts.get(id) ?? null;
  }
  async remove(projectPath: string, id: string): Promise<void> {
    this.removed.push({ path: projectPath, id });
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

/**
 * Test double — the repository's other checkouts, and bringing one onto
 * the tab bar. Opening dispatches the same `tab/opened` the real
 * `Worktrees` does, so a session can be loaded into the tab it makes.
 */
class FakeWorktrees implements WorktreeAccess {
  checkouts: WorktreeItem[] = [];
  opened: Array<{ path: string; mainPath: string; sourceTabId?: string }> = [];
  /** Set to leave `open` a no-op: the folder was gone by the time we looked. */
  refusesToOpen = false;

  constructor(private readonly store: Store) {}

  async list(): Promise<readonly WorktreeItem[]> {
    return this.checkouts;
  }

  async open(path: string, mainPath: string, sourceTabId?: string): Promise<void> {
    this.opened.push({ path, mainPath, sourceTabId });
    if (this.refusesToOpen) return;
    const existing = this.store.getState().tabs.find((t) => t.project.path === path);
    if (existing) {
      this.store.dispatch({ type: "tab/activated", tabId: existing.project.id });
      return;
    }
    this.store.dispatch({
      type: "tab/opened",
      project: newProject(`tab:${path}`, path, DEFAULTS, "/repo"),
    });
  }
}

/** One checkout as `git worktree list` reports it, decorated. */
function checkout(partial: Partial<WorktreeItem> & { path: string }): WorktreeItem {
  return {
    branch: "feature/polish",
    head: "abc1234",
    main: false,
    bare: false,
    locked: false,
    prunable: false,
    openTabId: null,
    current: false,
    ...partial,
  };
}

function setup() {
  const store = new Store();
  store.dispatch({ type: "tab/opened", project: newProject("t1", "/repo", DEFAULTS) });
  const transcripts = new FakeTranscriptStore();
  const gateway = new FakeGateway();
  const worktrees = new FakeWorktrees(store);
  return {
    store,
    transcripts,
    gateway,
    worktrees,
    history: new SessionHistory(store, transcripts, gateway, worktrees),
  };
}

const DEFAULTS = projectDefaults(defaultSettings);

/** Let the fire-and-forget background refresh run to completion. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A local transcript with just enough shape to list. */
function meta(
  id: string,
  savedAt: number,
  providerSessionId?: string,
): PersistedTranscript {
  return {
    id,
    title: `chat ${id}`,
    savedAt,
    provider: "claude",
    providerSessionId,
    messages: [],
  };
}

/** A history row as the panel hands it back on click. */
function row(partial: Partial<HistoryItem> & Pick<HistoryItem, "id">): HistoryItem {
  return {
    title: `chat ${partial.id}`,
    savedAt: 0,
    provider: "claude",
    native: false,
    local: false,
    ...partial,
  };
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

  it("lists one conversation once: the agent's session merges with our copy of it", async () => {
    const { transcripts, gateway, history } = setup();
    transcripts.transcripts.set("local-1", meta("local-1", 500, "agent-9"));
    gateway.nativeSessions = [
      {
        sessionId: "agent-9",
        title: "The agent's own title",
        updatedAt: "2026-08-05T10:00:00Z",
      },
    ];

    const refreshed = await new Promise<HistoryListing>((resolve) => {
      void history.list("t1", resolve);
    });

    expect(refreshed.sessions).toHaveLength(1);
    const [only] = refreshed.sessions;
    // Ours to open, save and delete; the agent's to resume.
    expect(only.id).toBe("local-1");
    expect(only.providerSessionId).toBe("agent-9");
    expect(only.native).toBe(true);
    expect(only.local).toBe(true);
    expect(only.title).toBe("chat local-1"); // the prompt the user typed
  });

  it("absorbs the duplicate an older build left: a transcript saved under the agent's id", async () => {
    const { transcripts, gateway, history } = setup();
    transcripts.transcripts.set("agent-9", meta("agent-9", 500));
    gateway.nativeSessions = [
      { sessionId: "agent-9", updatedAt: "2026-08-05T10:00:00Z" },
    ];

    const refreshed = await new Promise<HistoryListing>((resolve) => {
      void history.list("t1", resolve);
    });

    expect(refreshed.sessions).toHaveLength(1);
    expect(refreshed.sessions[0].local).toBe(true);
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

  it("lists the vendor's own sessions when no live agent exists to ask", async () => {
    const { transcripts, gateway, history } = setup();
    gateway.nativeSessions = null; // no live session — and none is booted
    transcripts.external = [
      { sessionId: "cli-1", title: "started in a terminal", updatedAtMs: 900 },
    ];

    const refreshed = await new Promise<HistoryListing>((resolve) => {
      void history.list("t1", resolve);
    });

    expect(refreshed.native).toBe(true);
    const [only] = refreshed.sessions;
    expect(only.id).toBe("cli-1");
    expect(only.title).toBe("started in a terminal");
    expect(only.savedAt).toBe(900);
    expect(only.native).toBe(true); // the store is shared: opening resumes
    expect(only.local).toBe(false); // nothing of ours to delete
  });

  it("keeps one row when the vendor's store and our transcript hold the same chat", async () => {
    const { transcripts, gateway, history } = setup();
    transcripts.transcripts.set("local-1", meta("local-1", 500, "cli-1"));
    gateway.nativeSessions = null;
    transcripts.external = [
      { sessionId: "cli-1", title: "vendor title", updatedAtMs: 900 },
    ];

    const refreshed = await new Promise<HistoryListing>((resolve) => {
      void history.list("t1", resolve);
    });

    expect(refreshed.sessions).toHaveLength(1);
    const [only] = refreshed.sessions;
    expect(only.id).toBe("local-1"); // ours to open, save and delete
    expect(only.title).toBe("chat local-1");
    expect(only.savedAt).toBe(500); // last message, not the file's mtime
    expect(only.local).toBe(true);
  });

  it("lets the live agent's listing win over the vendor's store for the same id", async () => {
    const { transcripts, gateway, history } = setup();
    gateway.nativeSessions = [
      { sessionId: "cli-1", title: "Agent title", updatedAt: "2026-08-05T10:00:00Z" },
    ];
    transcripts.external = [
      { sessionId: "cli-1", title: "stale head", updatedAtMs: 1 },
      { sessionId: "cli-2", title: "only in the store", updatedAtMs: 2 },
    ];

    const refreshed = await new Promise<HistoryListing>((resolve) => {
      void history.list("t1", resolve);
    });

    const byId = new Map(refreshed.sessions.map((s) => [s.id, s]));
    expect(refreshed.sessions).toHaveLength(2);
    expect(byId.get("cli-1")?.title).toBe("Agent title");
    expect(byId.get("cli-2")?.title).toBe("only in the store");
  });

  it("never reads the vendor's store for a provider that doesn't own it", async () => {
    const store = new Store();
    store.dispatch({
      type: "tab/opened",
      project: newProject("t1", "/repo", { ...DEFAULTS, provider: "codex" }),
    });
    const transcripts = new FakeTranscriptStore();
    const gateway = new FakeGateway();
    const history = new SessionHistory(
      store,
      transcripts,
      gateway,
      new FakeWorktrees(store),
    );

    await history.list("t1", () => {});
    await settle();

    expect(transcripts.externalCalls).toBe(0);
  });

  it("still lists the vendor's store when the live listing fails", async () => {
    const { transcripts, gateway, history } = setup();
    gateway.listError = "agent broke";
    transcripts.external = [
      { sessionId: "cli-1", title: "survives the failure", updatedAtMs: 900 },
    ];

    const refreshed = await new Promise<HistoryListing>((resolve) => {
      void history.list("t1", resolve);
    });

    expect(refreshed.error).toBeUndefined();
    expect(refreshed.sessions.map((s) => s.id)).toEqual(["cli-1"]);
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

    await history.open("t1", row({ id: "abc-123", native: true }));

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

    await history.open("t1", row({ id: "abc-123", native: true }));

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
    // 200k on a 1M-window model is the adapter's placeholder size, so
    // the replayed usage carries the provisional mark too.
    expect(tab.usage).toEqual({ used: 1200, size: 200000, provisional: true });
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

    await history.open("t1", row({ id: "abc-123", native: true }));

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

    await history.open("t1", row({ id: "abc-123", native: true }));

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

    await history.open("t1", row({ id: "abc-123", native: true, local: true }));

    const tab = store.getState().tabs[0];
    expect(gateway.lastLoad?.preferResume).toBe(true);
    expect(tab.messages.map((m) => m.role)).toEqual(["user", "assistant", "info"]);
    expect(tab.messages.at(-1)?.text).toContain("remembers");
    expect(tab.plan).toHaveLength(1);
    expect(tab.historySessionId).toBe("abc-123");
    expect(tab.busy).toBe(false);
  });

  it("opening a conversation we already hold writes no second transcript", async () => {
    const { store, transcripts, gateway, history } = setup();
    transcripts.transcripts.set("local-1", {
      ...meta("local-1", 500, "agent-9"),
      messages: [{ id: "m1", role: "user", text: "plan it" }],
    });
    gateway.replay = [{ kind: "userDelta", text: "plan it" }];

    await history.open(
      "t1",
      row({
        id: "local-1",
        providerSessionId: "agent-9",
        savedAt: 500,
        native: true,
        local: true,
      }),
    );

    // The agent is asked for ITS session; the transcript stays ours, and
    // stays ONE file — a second one is a second row for the same chat.
    expect(gateway.lastLoad?.sessionId).toBe("agent-9");
    expect([...transcripts.transcripts.keys()]).toEqual(["local-1"]);
    const tab = store.getState().tabs[0];
    expect(tab.historySessionId).toBe("local-1");
    // Recorded, so the next save stamps the session it really ran in.
    expect(tab.project.providerSessions.claude).toBe("agent-9");
  });

  it("adopts a session started outside the app, pinned where it was listed", async () => {
    const { transcripts, gateway, history } = setup();
    gateway.replay = [{ kind: "userDelta", text: "plan the feature" }];

    await history.open(
      "t1",
      row({ id: "agent-9", providerSessionId: "agent-9", savedAt: 4200, native: true }),
    );

    const saved = transcripts.transcripts.get("agent-9");
    expect(saved?.providerSessionId).toBe("agent-9");
    expect(saved?.savedAt).toBe(4200); // opening must not reorder history
    expect(saved?.title).toBe("plan the feature");
  });

  it("never asks for a resume without a local copy to paint from", async () => {
    const { gateway, history } = setup();
    gateway.replay = [{ kind: "userDelta", text: "plan the feature" }];

    await history.open("t1", row({ id: "abc-123", native: true }));

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

    await history.open("t1", row({ id: "s1", local: true }));

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

    await history.open("t1", row({ id: "s1", local: true }));

    const infos = store.getState().tabs[0].messages.filter((m) => m.role === "info");
    expect(infos.some((m) => m.text.includes("no longer exists"))).toBe(true);
  });

  describe("the repository's other checkouts", () => {
    /** A main checkout with one worktree that has a session of its own. */
    function withWorktree() {
      const kit = setup();
      kit.worktrees.checkouts = [
        checkout({ path: "/repo", branch: "main", main: true, current: true }),
        checkout({ path: "/repo-worktrees/polish" }),
      ];
      kit.transcripts.elsewhere.set("/repo-worktrees/polish", [
        { id: "w1", title: "in the worktree", savedAt: 500, provider: "claude" },
      ]);
      return kit;
    }

    it("lists a worktree's sessions on the main checkout's tab", async () => {
      const { transcripts, history } = withWorktree();
      transcripts.transcripts.set("s1", meta("s1", 100));

      const listing = await history.list("t1");

      expect(listing.sessions.map((s) => s.id)).toEqual(["w1", "s1"]);
      expect(listing.sessions[0].from).toEqual({
        path: "/repo-worktrees/polish",
        label: "feature/polish",
      });
      expect(listing.sessions[1].from).toBeUndefined();
    });

    it("names a detached worktree by its folder, having no branch to use", async () => {
      const { worktrees, history } = withWorktree();
      worktrees.checkouts[1] = checkout({ path: "/repo-worktrees/polish", branch: "" });

      const listing = await history.list("t1");

      expect(listing.sessions[0].from?.label).toBe("polish");
    });

    it("leaves out a worktree whose folder git has yet to prune", async () => {
      const { worktrees, history } = withWorktree();
      worktrees.checkouts[1] = {
        ...worktrees.checkouts[1],
        prunable: true,
      };

      expect((await history.list("t1")).sessions).toEqual([]);
    });

    it("shows a worktree tab only its own sessions", async () => {
      const { store, transcripts, history } = withWorktree();
      store.dispatch({
        type: "tab/opened",
        project: newProject("t2", "/repo-worktrees/polish", DEFAULTS, "/repo"),
      });
      transcripts.transcripts.set("s1", meta("s1", 100));

      const listing = await history.list("t2");

      // Its own folder's transcript, untagged — and never the main
      // checkout's, which is the tab the whole-repository view lives on.
      expect(listing.sessions.map((s) => s.id)).toEqual(["w1"]);
      expect(listing.sessions[0].from).toBeUndefined();
    });

    it("keeps the worktrees' rows when the agent's listing lands", async () => {
      const { gateway, history } = withWorktree();
      gateway.nativeSessions = [{ sessionId: "n1", title: "native", updatedAt: "" }];

      const refreshed = await new Promise<HistoryListing>((resolve) => {
        void history.list("t1", resolve);
      });

      expect(refreshed.sessions.map((s) => s.id)).toEqual(["w1", "n1"]);
    });

    it("opens a worktree's session in a tab of its own", async () => {
      const { store, worktrees, transcripts, history } = withWorktree();
      transcripts.transcripts.set("w1", {
        id: "w1",
        title: "in the worktree",
        savedAt: 500,
        provider: "claude",
        messages: [{ id: "m1", role: "user", text: "hello from the worktree" }],
      });

      await history.open("t1", await worktreeRow(history));

      expect(worktrees.opened).toEqual([
        { path: "/repo-worktrees/polish", mainPath: "/repo", sourceTabId: "t1" },
      ]);
      const opened = store.getState().tabs[1];
      expect(opened.project.path).toBe("/repo-worktrees/polish");
      expect(opened.historySessionId).toBe("w1");
      expect(opened.messages[0].text).toBe("hello from the worktree");
      // The tab it was opened FROM must be left exactly as it was.
      expect(store.getState().tabs[0].messages).toEqual([]);
    });

    it("loads nothing when the worktree's folder could not be opened", async () => {
      const { store, worktrees, history } = withWorktree();
      worktrees.refusesToOpen = true;

      await history.open("t1", await worktreeRow(history));

      expect(store.getState().tabs).toHaveLength(1);
      expect(store.getState().tabs[0].messages).toEqual([]);
    });

    it("deletes a worktree's transcript from the worktree's own folder", async () => {
      const { transcripts, history } = withWorktree();

      await history.remove("t1", await worktreeRow(history));

      expect(transcripts.removed).toEqual([{ path: "/repo-worktrees/polish", id: "w1" }]);
    });

    it("deletes this tab's own transcript from this tab's folder", async () => {
      const { transcripts, history } = withWorktree();

      await history.remove("t1", row({ id: "s1", local: true }));

      expect(transcripts.removed).toEqual([{ path: "/repo", id: "s1" }]);
    });

    it("offers the worktrees' sessions on their own, for the worktree panel", async () => {
      const { transcripts, history } = withWorktree();
      transcripts.transcripts.set("s1", meta("s1", 100));

      const sessions = await history.listWorktreeSessions("t1");

      expect(sessions.map((s) => s.id)).toEqual(["w1"]);
    });
  });
});

/** The listing's worktree row, as the panel would hand it back. */
async function worktreeRow(history: SessionHistory): Promise<HistoryItem> {
  const sessions = await history.listWorktreeSessions("t1");
  return sessions[0];
}
