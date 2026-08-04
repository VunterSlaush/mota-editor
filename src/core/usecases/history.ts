import { infoMessage, toolMessage } from "../entities/message";
import type { AgentGateway, AgentTurnEvent } from "../ports/agentGateway";
import type { TranscriptMeta, TranscriptStore } from "../ports/transcriptStore";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/** The history list plus where it came from. */
export interface HistoryListing {
  /** True when the entries are the AGENT's own sessions (true resume). */
  readonly native: boolean;
  readonly sessions: readonly TranscriptMeta[];
}

/**
 * Use cases — the session-history panel. The AGENT's own session store
 * is the primary source (no duplication, and reopening truly resumes
 * with the agent's memory); our local transcript store is the fallback
 * for providers without native history.
 */
export class SessionHistory {
  constructor(
    private readonly store: Store,
    private readonly transcriptStore: TranscriptStore,
    private readonly agentGateway: AgentGateway,
  ) {}

  async list(tabId: string): Promise<HistoryListing> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return { native: false, sessions: [] };
    const { provider, path, model, effort } = tab.project;

    try {
      const native = await this.agentGateway.listNativeSessions(
        tabId,
        provider,
        path,
        model,
        effort,
      );
      return {
        native: true,
        sessions: native.map((s) => ({
          id: s.sessionId,
          title: s.title?.trim() || s.sessionId.slice(0, 8),
          savedAt: s.updatedAt ? Date.parse(s.updatedAt) : 0,
          provider,
          messageCount: 0,
        })),
      };
    } catch {
      const local = await this.transcriptStore.list(path).catch(() => []);
      return { native: false, sessions: local };
    }
  }

  async open(tabId: string, sessionId: string, native: boolean): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab || tab.busy) return;
    if (native) {
      await this.openNative(tabId, sessionId);
    } else {
      await this.openLocal(tabId, sessionId);
    }
  }

  /** True resume: the agent replays and REMEMBERS the conversation. */
  private async openNative(tabId: string, sessionId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId)!;
    const { provider, path, model, effort } = tab.project;

    this.store.dispatch({ type: "chat/cleared", tabId });
    this.store.dispatch({ type: "chat/busyChanged", tabId, busy: true });
    try {
      await this.agentGateway.loadNativeSession(
        { tabId, provider, projectPath: path, model, effort, sessionId },
        (event) => this.foldReplayEvent(tabId, event),
      );
      this.store.dispatch({
        type: "chat/messageAppended",
        tabId,
        message: infoMessage("Resumed — the agent remembers this conversation."),
      });
      this.store.dispatch({ type: "chat/historySessionAssigned", tabId, sessionId });
    } catch (e) {
      this.store.dispatch({
        type: "chat/messageAppended",
        tabId,
        message: infoMessage(
          `Could not resume this session: ${e instanceof Error ? e.message : String(e)}`,
        ),
      });
    } finally {
      this.store.dispatch({ type: "chat/busyChanged", tabId, busy: false });
    }
  }

  /** Replay events → chat messages (approvals/completions don't replay). */
  private foldReplayEvent(tabId: string, event: AgentTurnEvent): void {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return;
    const last = tab.messages[tab.messages.length - 1];

    switch (event.kind) {
      case "userDelta":
        if (last?.role === "user") {
          this.store.dispatch({ type: "chat/userDelta", tabId, text: event.text });
        } else {
          this.store.dispatch({
            type: "chat/messageAppended",
            tabId,
            message: { id: `r-${tab.messages.length}`, role: "user", text: event.text },
          });
        }
        break;
      case "assistantDelta":
        if (last?.role === "assistant") {
          this.store.dispatch({ type: "chat/assistantDelta", tabId, text: event.text });
        } else {
          this.store.dispatch({
            type: "chat/messageAppended",
            tabId,
            message: {
              id: `r-${tab.messages.length}`,
              role: "assistant",
              text: event.text,
            },
          });
        }
        break;
      case "tool":
        this.store.dispatch({
          type: "chat/messageAppended",
          tabId,
          message: toolMessage(event.name, event.detail),
        });
        break;
      case "plan":
        this.store.dispatch({ type: "tab/planUpdated", tabId, plan: event.entries });
        break;
      default:
        break; // usage, thoughts, etc.: not part of the restored view
    }
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
      ? await this.transcriptStore.readPlanFile(transcript.planFilePath).catch(() => null)
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

  startNew(tabId: string): void {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab || tab.busy) return;
    this.store.dispatch({ type: "chat/cleared", tabId });
  }

  async remove(tabId: string, sessionId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return;
    await this.transcriptStore.remove(tab.project.path, sessionId).catch(() => undefined);
  }
}
