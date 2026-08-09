import { describe, expect, it } from "vitest";
import { userMessage } from "../entities/message";
import { newProject } from "../entities/project";
import {
  type AppState,
  activeTab,
  defaultSettings,
  initialState,
  projectDefaults,
  reduce,
} from "./appState";

const DEFAULTS = projectDefaults(defaultSettings);

const open = (state: AppState, id: string, path: string) =>
  reduce(state, { type: "tab/opened", project: newProject(id, path, DEFAULTS) });

const ids = (state: AppState) => state.tabs.map((t) => t.project.id);

describe("appState reducer", () => {
  it("opens a project as the active tab", () => {
    const state = open(initialState, "t1", "C:\\work\\alpha");
    expect(state.tabs).toHaveLength(1);
    expect(state.activeTabId).toBe("t1");
    expect(activeTab(state)?.project.name).toBe("alpha");
  });

  it("re-activates the existing tab when the same folder is opened twice", () => {
    let state = open(initialState, "t1", "/work/alpha");
    state = open(state, "t2", "/work/beta");
    state = open(state, "t3", "/work/alpha");
    expect(state.tabs).toHaveLength(2);
    expect(state.activeTabId).toBe("t1");
  });

  it("closing the active tab activates the last remaining tab", () => {
    let state = open(initialState, "t1", "/a");
    state = open(state, "t2", "/b");
    state = reduce(state, { type: "tab/activated", tabId: "t2" });
    state = reduce(state, { type: "tab/closed", tabId: "t2" });
    expect(state.activeTabId).toBe("t1");
  });

  it("closing an inactive tab keeps the current tab active", () => {
    let state = open(initialState, "t1", "/a");
    state = open(state, "t2", "/b");
    state = reduce(state, { type: "tab/closed", tabId: "t1" });
    expect(state.activeTabId).toBe("t2");
  });

  it("moving a tab to the front reorders the list", () => {
    let state = open(initialState, "t1", "/a");
    state = open(state, "t2", "/b");
    state = open(state, "t3", "/c");
    state = reduce(state, { type: "tab/moved", tabId: "t3", toIndex: 0 });
    expect(ids(state)).toEqual(["t3", "t1", "t2"]);
  });

  it("moving a tab past the end lands it in the last position", () => {
    let state = open(initialState, "t1", "/a");
    state = open(state, "t2", "/b");
    state = reduce(state, { type: "tab/moved", tabId: "t1", toIndex: 9 });
    expect(ids(state)).toEqual(["t2", "t1"]);
  });

  it("moving a tab onto its own position changes nothing", () => {
    let state = open(initialState, "t1", "/a");
    state = open(state, "t2", "/b");
    const moved = reduce(state, { type: "tab/moved", tabId: "t2", toIndex: 1 });
    expect(moved).toBe(state);
  });

  it("moving an unknown tab is ignored", () => {
    const state = open(initialState, "t1", "/a");
    const moved = reduce(state, { type: "tab/moved", tabId: "nope", toIndex: 0 });
    expect(moved).toBe(state);
  });

  it("reordering keeps the active tab active", () => {
    let state = open(initialState, "t1", "/a");
    state = open(state, "t2", "/b");
    state = reduce(state, { type: "tab/activated", tabId: "t1" });
    state = reduce(state, { type: "tab/moved", tabId: "t2", toIndex: 0 });
    expect(state.activeTabId).toBe("t1");
  });

  it("closing the last tab leaves no active tab", () => {
    let state = open(initialState, "t1", "/a");
    state = reduce(state, { type: "tab/closed", tabId: "t1" });
    expect(state.activeTabId).toBeNull();
    expect(activeTab(state)).toBeNull();
  });

  it("appends chat messages to the right tab only", () => {
    let state = open(initialState, "t1", "/a");
    state = open(state, "t2", "/b");
    state = reduce(state, {
      type: "chat/messageAppended",
      tabId: "t1",
      message: userMessage("hello"),
    });
    expect(state.tabs[0].messages).toHaveLength(1);
    expect(state.tabs[1].messages).toHaveLength(0);
  });

  it("records provider session ids per provider", () => {
    let state = open(initialState, "t1", "/a");
    state = reduce(state, {
      type: "chat/sessionRecorded",
      tabId: "t1",
      provider: "claude",
      sessionId: "s-123",
    });
    expect(state.tabs[0].project.providerSessions.claude).toBe("s-123");
    expect(state.tabs[0].project.providerSessions.codex).toBeUndefined();
  });

  it("changes mode and permission independently per tab", () => {
    let state = open(initialState, "t1", "/a");
    state = open(state, "t2", "/b");
    state = reduce(state, { type: "tab/modeChanged", tabId: "t1", mode: "plan" });
    state = reduce(state, {
      type: "tab/permissionChanged",
      tabId: "t1",
      permission: "bypass",
    });
    expect(state.tabs[0].project.mode).toBe("plan");
    expect(state.tabs[0].project.permission).toBe("bypass");
    expect(state.tabs[1].project.mode).toBe("agent");
    expect(state.tabs[1].project.permission).toBe("manual");
  });

  it("stores the model per tab, treating blank as default", () => {
    let state = open(initialState, "t1", "/a");
    state = reduce(state, { type: "tab/modelChanged", tabId: "t1", model: "fable" });
    expect(state.tabs[0].project.model).toBe("fable");
    state = reduce(state, { type: "tab/modelChanged", tabId: "t1", model: "   " });
    expect(state.tabs[0].project.model).toBeUndefined();
  });

  it("stores the reasoning effort per tab, treating blank as default", () => {
    let state = open(initialState, "t1", "/a");
    state = reduce(state, { type: "tab/effortChanged", tabId: "t1", effort: "xhigh" });
    expect(state.tabs[0].project.effort).toBe("xhigh");
    state = reduce(state, { type: "tab/effortChanged", tabId: "t1", effort: "" });
    expect(state.tabs[0].project.effort).toBeUndefined();
  });

  it("keeps each tab's draft prompt across a tab switch", () => {
    let state = open(initialState, "t1", "/a");
    state = open(state, "t2", "/b");
    state = reduce(state, {
      type: "chat/draftChanged",
      tabId: "t1",
      draft: "half a thought",
      attachments: ["/a/notes.md"],
    });

    // Leaving and coming back is what used to bin the text.
    state = reduce(state, { type: "tab/activated", tabId: "t2" });
    state = reduce(state, { type: "tab/activated", tabId: "t1" });

    expect(state.tabs[0].draft).toBe("half a thought");
    expect(state.tabs[0].draftAttachments).toEqual(["/a/notes.md"]);
    expect(state.tabs[1].draft).toBeUndefined();
  });

  it("stamps the turn's start time while busy and clears it after", () => {
    let state = open(initialState, "t1", "/a");
    state = reduce(state, {
      type: "chat/busyChanged",
      tabId: "t1",
      busy: true,
      at: 1_000,
    });
    expect(state.tabs[0].turnStartedAt).toBe(1_000);

    // A later busy=true without a clock must not restart the counter.
    state = reduce(state, { type: "chat/busyChanged", tabId: "t1", busy: true });
    expect(state.tabs[0].turnStartedAt).toBe(1_000);

    state = reduce(state, { type: "chat/busyChanged", tabId: "t1", busy: false });
    expect(state.tabs[0].turnStartedAt).toBeUndefined();
  });

  it("stores agent-advertised commands per tab", () => {
    let state = open(initialState, "t1", "/a");
    state = reduce(state, {
      type: "tab/commandsUpdated",
      tabId: "t1",
      commands: [{ name: "/compact", description: "Summarize", source: "builtin" }],
    });
    expect(state.tabs[0].agentCommands).toHaveLength(1);
    expect(state.tabs[0].agentCommands[0].name).toBe("/compact");
  });

  it("replaces the plan wholesale and toggles verbose per tab", () => {
    let state = open(initialState, "t1", "/a");
    expect(state.tabs[0].project.verbose).toBe(true); // verbose is the default

    state = reduce(state, {
      type: "tab/planUpdated",
      tabId: "t1",
      plan: [
        { content: "Step one", priority: "high", status: "completed" },
        { content: "Step two", priority: "medium", status: "pending" },
      ],
    });
    state = reduce(state, {
      type: "tab/planUpdated",
      tabId: "t1",
      plan: [{ content: "Only step", priority: "low", status: "in_progress" }],
    });
    expect(state.tabs[0].plan).toHaveLength(1);
    expect(state.tabs[0].plan[0].content).toBe("Only step");

    state = reduce(state, { type: "tab/verboseChanged", tabId: "t1", verbose: false });
    expect(state.tabs[0].project.verbose).toBe(false);
  });

  it("thought deltas extend only a trailing thought message", () => {
    let state = open(initialState, "t1", "/a");
    state = reduce(state, {
      type: "chat/messageAppended",
      tabId: "t1",
      message: { id: "th1", role: "thought", text: "Consider" },
    });
    state = reduce(state, { type: "chat/thoughtDelta", tabId: "t1", text: "ing…" });
    expect(state.tabs[0].messages[0].text).toBe("Considering…");

    // A thought delta never extends an assistant bubble.
    state = reduce(state, {
      type: "chat/messageAppended",
      tabId: "t1",
      message: { id: "a1", role: "assistant", text: "Answer" },
    });
    state = reduce(state, { type: "chat/thoughtDelta", tabId: "t1", text: "X" });
    expect(state.tabs[0].messages[1].text).toBe("Answer");
  });

  it("switching provider keeps prior provider sessions", () => {
    let state = open(initialState, "t1", "/a");
    state = reduce(state, {
      type: "chat/sessionRecorded",
      tabId: "t1",
      provider: "claude",
      sessionId: "s-123",
    });
    state = reduce(state, {
      type: "tab/providerChanged",
      tabId: "t1",
      provider: "codex",
    });
    expect(state.tabs[0].project.provider).toBe("codex");
    expect(state.tabs[0].project.providerSessions.claude).toBe("s-123");
  });

  it("a settings patch changes only the keys it names", () => {
    let state = reduce(initialState, {
      type: "settings/changed",
      patch: { defaultMode: "plan" },
    });
    state = reduce(state, {
      type: "settings/changed",
      patch: { defaultProvider: "gemini" },
    });
    expect(state.settings.defaultMode).toBe("plan");
    expect(state.settings.defaultProvider).toBe("gemini");
    expect(state.settings.defaultPermission).toBe(
      initialState.settings.defaultPermission,
    );
  });

  it("new tabs start from the defaults, tabs already open do not move", () => {
    let state = open(initialState, "t1", "/a");
    state = reduce(state, {
      type: "settings/changed",
      patch: { defaultMode: "debug", defaultEffort: { claude: "max" } },
    });
    state = reduce(state, {
      type: "tab/opened",
      project: newProject("t2", "/b", projectDefaults(state.settings)),
    });
    expect(state.tabs[0].project.mode).toBe("agent"); // untouched
    expect(state.tabs[1].project.mode).toBe("debug");
    expect(state.tabs[1].project.effort).toBe("max");
  });
});

describe("chat/turnMetaCompleted", () => {
  const meta = { sentAt: 1000, mode: "agent", permission: "manual" };

  it("patches exactly the addressed message", () => {
    let state = open(initialState, "t1", "/a");
    const first = userMessage("one", [], meta);
    const second = userMessage("two", [], meta);
    state = reduce(state, { type: "chat/messageAppended", tabId: "t1", message: first });
    state = reduce(state, { type: "chat/messageAppended", tabId: "t1", message: second });

    state = reduce(state, {
      type: "chat/turnMetaCompleted",
      tabId: "t1",
      messageId: first.id,
      patch: { durationMs: 250, tokens: 600 },
    });

    const [patched, untouched] = state.tabs[0].messages;
    expect(patched.turn).toMatchObject({ ...meta, durationMs: 250, tokens: 600 });
    expect(untouched).toBe(second); // same object — memoized rows stay put
  });

  it("ignores unknown ids and messages without turn meta", () => {
    let state = open(initialState, "t1", "/a");
    const bare = userMessage("no meta");
    state = reduce(state, { type: "chat/messageAppended", tabId: "t1", message: bare });
    const before = state.tabs[0].messages;

    state = reduce(state, {
      type: "chat/turnMetaCompleted",
      tabId: "t1",
      messageId: bare.id,
      patch: { durationMs: 1 },
    });
    state = reduce(state, {
      type: "chat/turnMetaCompleted",
      tabId: "t1",
      messageId: "nope",
      patch: { durationMs: 1 },
    });

    expect(state.tabs[0].messages[0]).toBe(before[0]);
    expect(state.tabs[0].messages[0].turn).toBeUndefined();
  });
});

describe("tab/planMarkdownUpdated", () => {
  it("a new plan supersedes the old checklist and file path", () => {
    let state = open(initialState, "t1", "/a");
    state = reduce(state, {
      type: "tab/planUpdated",
      tabId: "t1",
      plan: [{ content: "old step", status: "completed", priority: "medium" }],
    });
    state = reduce(state, {
      type: "tab/planMarkdownUpdated",
      tabId: "t1",
      markdown: "# Plan A",
      filePath: "/plans/a.md",
    });

    state = reduce(state, {
      type: "tab/planMarkdownUpdated",
      tabId: "t1",
      markdown: "# Plan B",
    });

    const tab = state.tabs[0];
    expect(tab.planMarkdown).toBe("# Plan B");
    expect(tab.plan).toEqual([]); // stale checklist must not shadow the new plan
    expect(tab.planFilePath).toBeUndefined(); // A's file must not resurrect on reopen
  });
});
