import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assistantMessage, userMessage } from "../entities/message";
import { newProject } from "../entities/project";
import type { AgentGateway, AgentTurnEvent } from "../ports/agentGateway";
import type {
  PersistedTranscript,
  TranscriptMeta,
  TranscriptStore,
} from "../ports/transcriptStore";
import { defaultSettings, projectDefaults, tabById } from "../state/appState";
import { Store } from "../state/store";
import { RETIRED_IDLE_LIMIT_MS, RetiredChats } from "./retiredChats";
import { FOLLOWUP_SETTLE_MS } from "./sendPrompt";

const DEFAULTS = projectDefaults(defaultSettings);

class FakeGateway implements Partial<AgentGateway> {
  discarded: { tabId: string; chatId: string }[] = [];
  async discardRetired(tabId: string, chatId: string): Promise<void> {
    this.discarded.push({ tabId, chatId });
  }
}

class FakeTranscriptStore implements Partial<TranscriptStore> {
  saved: PersistedTranscript[] = [];
  async save(_projectPath: string, transcript: PersistedTranscript) {
    this.saved.push(transcript);
  }
  async list(): Promise<TranscriptMeta[]> {
    return [];
  }
}

class FakeNotifications {
  shown: { title: string; body: string }[] = [];
  async turnCompleted() {}
  async show(title: string, body: string) {
    this.shown.push({ title, body });
  }
}

/**
 * A tab mid-conversation, as "New chat" finds it: a prompt asking the
 * agent to report back, and the transcript row it has been saving to.
 */
function setup(over: { historySessionId?: string } = { historySessionId: "h1" }) {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", DEFAULTS),
  });
  store.dispatch({
    type: "chat/messageAppended",
    tabId: "t1",
    message: userMessage("watch CI and tell me"),
  });
  store.dispatch({
    type: "chat/messageAppended",
    tabId: "t1",
    message: assistantMessage("Will do."),
  });
  if (over.historySessionId) {
    store.dispatch({
      type: "chat/historySessionAssigned",
      tabId: "t1",
      sessionId: over.historySessionId,
    });
  }
  const gateway = new FakeGateway();
  const transcripts = new FakeTranscriptStore();
  const notifications = new FakeNotifications();
  let counter = 0;
  const retired = new RetiredChats(
    gateway as unknown as AgentGateway,
    transcripts as unknown as TranscriptStore,
    notifications,
    () => `new-${++counter}`,
  );

  const tab = tabById(store.getState(), "t1")!;
  retired.retire(tab);
  const say = (event: AgentTurnEvent) =>
    retired.accept({ tabId: "t1", chatId: tab.chatId, event });
  return { store, gateway, transcripts, notifications, retired, tab, say };
}

describe("a retired chat's agent comes back", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("appends what it said to the conversation it was asked in", async () => {
    const { transcripts, say } = setup();

    say({ kind: "assistant", text: "CI finished: 3 tests failed." });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1);

    const saved = transcripts.saved.at(-1);
    expect(saved?.messages.map((m) => m.text)).toEqual([
      "watch CI and tell me",
      "Will do.",
      "CI finished: 3 tests failed.",
    ]);
  });

  it("rewrites the History row that chat already had, not a new one", async () => {
    const { transcripts, say } = setup();

    say({ kind: "assistant", text: "CI is green." });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1);

    // A second row would show the same conversation twice, with the
    // answer in one of them and the question in the other.
    expect(transcripts.saved).toHaveLength(1);
    expect(transcripts.saved[0].id).toBe("h1");
  });

  it("gives a chat that was never saved a row of its own", async () => {
    const { transcripts, say } = setup({});

    say({ kind: "assistant", text: "CI is green." });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1);

    expect(transcripts.saved[0].id).toBe("new-1");
    expect(transcripts.saved[0].title).toBe("watch CI and tell me");
  });

  it("tells the user, who by definition was not watching", async () => {
    const { notifications, say } = setup();

    say({ kind: "assistant", text: "CI is green." });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1);

    expect(notifications.shown).toHaveLength(1);
    expect(notifications.shown[0].title).toBe("alpha");
  });

  it("keeps the stretch open while the agent is still working", async () => {
    const { transcripts, say } = setup();

    say({ kind: "assistant", text: "Reading the log…" });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS - 1);
    say({ kind: "assistant", text: "3 tests failed." });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS - 1);

    // Still mid-cycle: saving now would file half an answer and notify
    // about it, exactly the flicker FOLLOWUP_SETTLE_MS exists to stop.
    expect(transcripts.saved).toEqual([]);
    await vi.advanceTimersByTimeAsync(2);
    expect(transcripts.saved).toHaveLength(1);
  });

  it("ends the agent once it has had its say", async () => {
    const { gateway, tab, say } = setup();

    say({ kind: "assistant", text: "CI is green." });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1);

    expect(gateway.discarded).toEqual([{ tabId: "t1", chatId: tab.chatId }]);
  });

  it("streams deltas into one message, as the live chat does", async () => {
    const { transcripts, say } = setup();

    say({ kind: "assistantDelta", text: "CI " });
    say({ kind: "assistantDelta", text: "is green." });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1);

    // One bubble per stretch of assistant text, not one per token —
    // extending the previous assistant message is what the reducer does
    // on screen, and a transcript that disagreed would reopen as a
    // different conversation from the one that was had.
    const messages = transcripts.saved[0].messages;
    expect(messages).toHaveLength(2);
    expect(messages.at(-1)?.text).toBe("Will do.CI is green.");
  });

  it("records an approval it could not show as what it was", async () => {
    const { transcripts, say } = setup();

    say({
      kind: "permission",
      requestId: "1",
      title: "Run npm test",
      options: [{ optionId: "y", name: "Allow", kind: "allow_once" }],
    });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1);

    // Nobody can answer a card in a chat that is off screen — the
    // transcript should say the agent asked, not offer dead buttons.
    const last = transcripts.saved[0].messages.at(-1);
    expect(last?.role).toBe("info");
    expect(last?.approval).toBeUndefined();
  });
});

describe("a retired chat whose agent never comes back", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("is let go at the idle ceiling, silently", async () => {
    const { gateway, transcripts, notifications, tab } = setup();

    await vi.advanceTimersByTimeAsync(RETIRED_IDLE_LIMIT_MS + 1);

    // Nothing was said, so the transcript on disk is already right and
    // there is nothing to tell the user about.
    expect(transcripts.saved).toEqual([]);
    expect(notifications.shown).toEqual([]);
    expect(gateway.discarded).toEqual([{ tabId: "t1", chatId: tab.chatId }]);
  });

  it("says nothing for a stretch of pure bookkeeping", async () => {
    const { transcripts, notifications, say } = setup();

    say({ kind: "usage", used: 900, size: 200_000 });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1);

    expect(transcripts.saved).toEqual([]);
    expect(notifications.shown).toEqual([]);
  });

  it("ignores an event stamped with a different conversation", async () => {
    const { transcripts, retired, say } = setup();

    retired.accept({
      tabId: "t1",
      chatId: "t1#99",
      event: { kind: "assistant", text: "not this chat's" },
    });
    say({ kind: "assistant", text: "this chat's" });
    await vi.advanceTimersByTimeAsync(FOLLOWUP_SETTLE_MS + 1);

    expect(transcripts.saved[0].messages.map((m) => m.text)).not.toContain(
      "not this chat's",
    );
  });
});

describe("only one chat is retired per tab", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("lets the previous agent go when a second chat is retired", async () => {
    const { store, gateway, retired, tab } = setup();

    // A second "New chat" — the reducer mints the next conversation.
    store.dispatch({ type: "chat/sessionReset", tabId: "t1", provider: "claude" });
    retired.retire(tabById(store.getState(), "t1")!);

    expect(gateway.discarded[0]).toEqual({ tabId: "t1", chatId: tab.chatId });
  });

  it("keeps no agent for a chat that was never used", async () => {
    const store = new Store();
    store.dispatch({
      type: "tab/opened",
      project: newProject("t2", "/work/beta", DEFAULTS),
    });
    const gateway = new FakeGateway();
    const retired = new RetiredChats(
      gateway as unknown as AgentGateway,
      new FakeTranscriptStore() as unknown as TranscriptStore,
      new FakeNotifications(),
      () => "new-1",
    );
    const tab = tabById(store.getState(), "t2")!;

    retired.retire(tab);

    // Nothing was ever asked, so nothing can be watching.
    expect(gateway.discarded).toEqual([{ tabId: "t2", chatId: tab.chatId }]);
  });
});
