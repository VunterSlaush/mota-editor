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
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { Store } from "../state/store";
import { SendPrompt } from "./sendPrompt";

/** Test double — a scripted agent, per the case study's in-memory gateways. */
class FakeAgentGateway implements AgentGateway {
  requests: AgentTurnRequest[] = [];
  script: AgentTurnEvent[] = [];
  failWith: string | null = null;
  permissionResponses: Array<{ requestId: string; optionId: string }> = [];

  async startTurn(
    request: AgentTurnRequest,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {
    if (this.failWith) throw new Error(this.failWith);
    this.requests.push(request);
    this.script.forEach(onEvent);
  }

  async cancelTurn(): Promise<void> {}

  async respondPermission(
    _tabId: string,
    requestId: string,
    optionId: string,
  ): Promise<void> {
    this.permissionResponses.push({ requestId, optionId });
  }

  async endSession(): Promise<void> {}
  async warmSession(): Promise<void> {}
  async listNativeSessions(): Promise<{ sessionId: string }[]> {
    return [];
  }
  async loadNativeSession(): Promise<void> {}
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
}

class FakeTranscriptStore implements TranscriptStore {
  saved: PersistedTranscript[] = [];
  async save(_projectPath: string, transcript: PersistedTranscript) {
    this.saved.push(transcript);
  }
  async list(): Promise<TranscriptMeta[]> {
    return [];
  }
  async load(): Promise<PersistedTranscript | null> {
    return null;
  }
  async remove(): Promise<void> {}
  async readPlanFile(): Promise<string | null> {
    return null;
  }
}

function setup(script: AgentTurnEvent[] = []) {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", "claude"),
  });
  const gateway = new FakeAgentGateway();
  gateway.script = script;
  const workspace = new FakeWorkspaceStore();
  const transcripts = new FakeTranscriptStore();
  const notifications = new FakeNotifications();
  let counter = 0;
  const useCase = new SendPrompt(
    store,
    gateway,
    workspace,
    transcripts,
    notifications,
    () => `s${++counter}`,
  );
  return { store, gateway, workspace, transcripts, notifications, useCase };
}

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

  it("flags a background tab and notifies when its turn completes", async () => {
    const { store, notifications, useCase } = setup([
      { kind: "completed", isError: false },
    ]);
    store.dispatch({
      type: "tab/opened",
      project: newProject("t2", "/work/beta", "claude"),
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

    expect(store.getState().tabs[0].usage).toEqual({ used: 180_000, size: 200_000 });
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

  it("saves the transcript to session history after a completed turn", async () => {
    const { store, transcripts, useCase } = setup([
      { kind: "assistant", text: "Done!" },
      { kind: "completed", isError: false },
    ]);

    await useCase.execute("t1", "refactor the login module please");
    await new Promise((resolve) => setTimeout(resolve, 0)); // saveTranscript is fire-and-forget

    expect(transcripts.saved).toHaveLength(1);
    expect(transcripts.saved[0].title).toBe("refactor the login module please");
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
