import { serversForProvider } from "../entities/mcpServer";
import {
  type ChatMessage,
  errorMessage,
  infoMessage,
  mergeToolCall,
  toolCallMessage,
  toolMessage,
} from "../entities/message";
import type { PlanEntry } from "../entities/plan";
import type { AgentGateway, AgentTurnEvent } from "../ports/agentGateway";
import type { TranscriptMeta, TranscriptStore } from "../ports/transcriptStore";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/** One history row: a transcript's metadata plus how it opens. */
export interface HistoryItem extends TranscriptMeta {
  /** True when the AGENT lists this session (opening truly resumes). */
  readonly native: boolean;
}

/** The history list plus where it came from. */
export interface HistoryListing {
  /** True when any entries are the AGENT's own sessions (true resume). */
  readonly native: boolean;
  readonly sessions: readonly HistoryItem[];
  /**
   * Why the native listing failed, when it did and there was nothing
   * local to show instead. An empty panel that could mean "no sessions"
   * or "the agent broke" is undebuggable — say which.
   */
  readonly error?: string;
}

/**
 * A replayed session, folded in memory before it reaches the store.
 *
 * The agent replays a saved conversation one event at a time. Dispatching
 * each one made the transcript build itself on screen and the view chase
 * the bottom all the way down; collecting them here means the whole
 * conversation arrives in a single update, already scrolled to the end.
 */
class ReplayedSession {
  readonly messages: ChatMessage[] = [];
  plan: readonly PlanEntry[] = [];
  /** The last usage the replay reported, restored with the transcript. */
  usage?: { used: number; size: number };
  /** Replayed tool calls by id, so their updates fold into place. */
  private readonly toolCalls = new Map<string, number>();

  /** Replay events → chat messages, at full fidelity: thoughts, tool
   *  calls with their final status/output, errors, and usage all come
   *  back. (Approvals/questions don't replay — they were answered.) */
  fold(event: AgentTurnEvent): void {
    switch (event.kind) {
      case "userDelta":
        this.appendOrExtend("user", event.text);
        break;
      case "assistantDelta":
        this.appendOrExtend("assistant", event.text);
        break;
      case "thoughtDelta":
        this.appendOrExtend("thought", event.text);
        break;
      case "tool":
        this.messages.push(toolMessage(event.name, event.detail));
        break;
      case "toolCall": {
        this.toolCalls.set(event.toolCallId, this.messages.length);
        this.messages.push(
          toolCallMessage(event.toolCallId, event.toolKind, event.title, event.status),
        );
        break;
      }
      case "toolCallUpdate": {
        const index = this.toolCalls.get(event.toolCallId);
        const message = index === undefined ? undefined : this.messages[index];
        if (index === undefined || !message?.toolCall) break;
        this.messages[index] = {
          ...message,
          text: event.title ?? message.text,
          toolCall: mergeToolCall(message.toolCall, event),
        };
        break;
      }
      case "error":
        this.messages.push(
          errorMessage(event.message, {
            context: event.context,
            stderrTail: event.stderrTail,
          }),
        );
        break;
      case "usage":
        this.usage = { used: event.used, size: event.size };
        break;
      case "plan":
        this.plan = event.entries;
        break;
      default:
        break; // session ids, stages, completions: not part of the view
    }
  }

  note(text: string): void {
    this.messages.push(infoMessage(text));
  }

  /** Streamed text extends the last message when the role still matches. */
  private appendOrExtend(role: "user" | "assistant" | "thought", text: string): void {
    const last = this.messages[this.messages.length - 1];
    if (last?.role === role) {
      this.messages[this.messages.length - 1] = { ...last, text: last.text + text };
      return;
    }
    this.messages.push({ id: `r-${this.messages.length}`, role, text });
  }
}

/**
 * Use cases — the session-history panel. Local-first: our own
 * transcript store paints the list instantly (it never needs an agent
 * process), and the AGENT's native listing arrives as a background
 * refresh — asked only of a session that is already live, never worth
 * booting one for. Native entries win the merge, so opening them truly
 * resumes with the agent's memory.
 */
export class SessionHistory {
  constructor(
    private readonly store: Store,
    private readonly transcriptStore: TranscriptStore,
    private readonly agentGateway: AgentGateway,
  ) {}

  /**
   * The listing to paint NOW, from the local store alone. When
   * `onRefresh` is given, the native listing is fetched in the
   * background and the merged result delivered through it — or nothing,
   * when no live session exists to ask.
   */
  async list(
    tabId: string,
    onRefresh?: (listing: HistoryListing) => void,
  ): Promise<HistoryListing> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return { native: false, sessions: [] };

    const local = await this.transcriptStore.list(tab.project.path).catch(() => []);
    if (onRefresh) void this.refreshFromAgent(tabId, local, onRefresh);
    return { native: false, sessions: local.map((m) => ({ ...m, native: false })) };
  }

  /**
   * Overlay the agent's own sessions on the local listing. Native ids
   * win (opening them truly resumes); local-only transcripts stay (the
   * agent may have pruned them, or never owned them); sessions the
   * agent knows and we never saw appear (created outside this app).
   */
  private async refreshFromAgent(
    tabId: string,
    local: readonly TranscriptMeta[],
    onRefresh: (listing: HistoryListing) => void,
  ): Promise<void> {
    const state = this.store.getState();
    const tab = tabById(state, tabId);
    if (!tab) return;
    const { provider, path, model, effort } = tab.project;

    try {
      const native = await this.agentGateway.listNativeSessions(
        tabId,
        provider,
        path,
        model,
        effort,
        serversForProvider(state.settings.mcpServers, provider),
      );
      // Null = no live session to ask — the local paint stands as is.
      if (!native) return;
      const localById = new Map(local.map((m) => [m.id, m]));
      const nativeSessions = native
        // One malformed entry must not throw the whole list away.
        .filter((s) => typeof s.sessionId === "string" && s.sessionId !== "")
        .map((s) => {
          const known = localById.get(s.sessionId);
          const updatedAt = s.updatedAt ? Date.parse(s.updatedAt) : Number.NaN;
          return {
            id: s.sessionId,
            title: s.title?.trim() || known?.title || s.sessionId.slice(0, 8),
            // Our transcript is saved only when a MESSAGE is sent, while
            // the agent's `updatedAt` also bumps on a mere open (loading
            // touches its session file). Our timestamp, when we have one,
            // keeps the list ordered by last message, not last look.
            savedAt: known?.savedAt ?? (Number.isNaN(updatedAt) ? 0 : updatedAt),
            provider,
            messageCount: known?.messageCount,
            native: true,
          };
        });
      if (nativeSessions.length === 0) return; // nothing beyond the local paint
      const nativeIds = new Set(nativeSessions.map((s) => s.id));
      const sessions = [
        ...nativeSessions,
        ...local
          .filter((m) => !nativeIds.has(m.id))
          .map((m) => ({ ...m, native: false })),
      ].sort((a, b) => b.savedAt - a.savedAt);
      onRefresh({ native: true, sessions });
    } catch (e) {
      // Best-effort refresh: the local list already painted. Only an
      // EMPTY panel needs the failure spelled out.
      if (local.length > 0) return;
      onRefresh({
        native: false,
        sessions: [],
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  async open(
    tabId: string,
    sessionId: string,
    native: boolean,
    /** The item's timestamp as listed, BEFORE this open touches anything. */
    savedAt = 0,
  ): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab || tab.busy) return;
    if (native) {
      await this.openNative(tabId, sessionId, savedAt);
    } else {
      await this.openLocal(tabId, sessionId);
    }
  }

  /** True resume: the agent replays and REMEMBERS the conversation. */
  private async openNative(
    tabId: string,
    sessionId: string,
    savedAt: number,
  ): Promise<void> {
    const state = this.store.getState();
    const tab = tabById(state, tabId)!;
    const { provider, path, model, effort } = tab.project;
    const mcpServers = serversForProvider(state.settings.mcpServers, provider);

    this.store.dispatch({ type: "chat/cleared", tabId });
    this.store.dispatch({ type: "chat/busyChanged", tabId, busy: true, at: Date.now() });

    // Our own copy of the conversation, when we saved one. It unlocks
    // `session/resume`: the agent attaches its memory WITHOUT the
    // (slow) full replay, because this copy can paint the screen.
    const localCopy = await this.transcriptStore.load(path, sessionId).catch(() => null);

    const replay = new ReplayedSession();
    let resumed = true;
    let replayed = true;
    try {
      ({ replayed } = await this.agentGateway.loadNativeSession(
        {
          tabId,
          provider,
          projectPath: path,
          model,
          effort,
          sessionId,
          mcpServers,
          preferResume: localCopy !== null,
        },
        (event) => replay.fold(event),
      ));
      replay.note("Resumed — the agent remembers this conversation.");
    } catch (e) {
      resumed = false;
      replay.note(
        `Could not resume this session: ${e instanceof Error ? e.message : String(e)}`,
      );
    }

    if (resumed) {
      const messages =
        replayed || !localCopy
          ? replay.messages
          : [
              ...localCopy.messages.map((m, index) => ({
                ...m,
                id: `${sessionId}-${index}`,
              })),
              ...replay.messages, // the "Resumed" note (and any stragglers)
            ];
      this.store.dispatch({
        type: "chat/transcriptLoaded",
        tabId,
        sessionId,
        messages,
        plan: replayed ? replay.plan : (localCopy?.plan ?? replay.plan),
      });
      if (replay.usage) {
        this.store.dispatch({ type: "tab/usageUpdated", tabId, ...replay.usage });
      }
      // Pin the item where it was: opening must not reorder history, so
      // the local copy keeps the PRE-open timestamp. Only sending a
      // message (which saves with a fresh savedAt) moves it to the top.
      // A resume needs no pin — it painted FROM the local copy, which
      // already holds its own timestamp.
      const firstUserMessage = replay.messages.find((m) => m.role === "user");
      if (replayed)
        void this.transcriptStore
          .save(tab.project.path, {
            id: sessionId,
            title: (firstUserMessage?.text ?? "Untitled").slice(0, 80),
            savedAt,
            provider,
            messages: replay.messages,
            plan: replay.plan.length > 0 ? replay.plan : undefined,
          })
          .catch(() => undefined); // the pin is best-effort, like all history
    } else {
      // A resume that failed must not leave the tab claiming that session.
      for (const message of replay.messages) {
        this.store.dispatch({ type: "chat/messageAppended", tabId, message });
      }
    }
    this.store.dispatch({ type: "chat/busyChanged", tabId, busy: false });
  }

  /** Fallback: our own transcript copy (view only, no agent memory). */
  private async openLocal(tabId: string, sessionId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId)!;
    const transcript = await this.transcriptStore
      .load(tab.project.path, sessionId)
      .catch(() => null);
    if (!transcript) return;

    const messages = transcript.messages.map((m, index) => ({
      ...m,
      id: `${sessionId}-${index}`,
    }));
    // The plan is stored as a PATH — read the content back from disk.
    const planMarkdown = transcript.planFilePath
      ? await this.transcriptStore
          .readPlanFile(tab.project.path, transcript.planFilePath)
          .catch(() => null)
      : null;

    this.store.dispatch({
      type: "chat/transcriptLoaded",
      tabId,
      sessionId,
      messages: [
        ...messages,
        infoMessage(
          "Loaded from history — the agent starts fresh and doesn't have this conversation in memory.",
        ),
      ],
      plan: transcript.plan,
      planMarkdown: planMarkdown ?? undefined,
    });
    if (transcript.planFilePath && !planMarkdown) {
      this.store.dispatch({
        type: "chat/messageAppended",
        tabId,
        message: infoMessage("This session's plan file no longer exists on disk."),
      });
    }
  }

  /**
   * A new conversation means a NEW AGENT CONTEXT, not just an empty
   * screen: the backend session is ended (so the agent forgets), the
   * resume id/usage/commands are dropped, and a fresh session pre-warms
   * so the first message stays fast.
   */
  async startNew(tabId: string): Promise<void> {
    const state = this.store.getState();
    const tab = tabById(state, tabId);
    if (!tab || tab.busy) return;
    const { provider, path, model, effort } = tab.project;

    await this.agentGateway.endSession(tabId).catch(() => undefined);
    this.store.dispatch({ type: "chat/cleared", tabId });
    this.store.dispatch({ type: "chat/sessionReset", tabId, provider });
    void this.agentGateway
      .warmSession(
        tabId,
        provider,
        path,
        model,
        effort,
        serversForProvider(state.settings.mcpServers, provider),
      )
      .catch(() => undefined); // warm-up is best-effort
  }

  async remove(tabId: string, sessionId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return;
    await this.transcriptStore.remove(tab.project.path, sessionId).catch(() => undefined);
  }
}
