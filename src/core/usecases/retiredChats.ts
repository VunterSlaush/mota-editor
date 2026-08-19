import {
  assistantMessage,
  type ChatMessage,
  errorMessage,
  infoMessage,
  mergeToolCall,
  thoughtMessage,
  toolCallMessage,
  toolMessage,
} from "../entities/message";
import type { PlanEntry } from "../entities/plan";
import { tabLabel } from "../entities/project";
import type { ProviderId } from "../entities/provider";
import type {
  AgentEventEnvelope,
  AgentGateway,
  AgentTurnEvent,
} from "../ports/agentGateway";
import type { NotificationPort } from "../ports/notificationPort";
import type { TranscriptStore } from "../ports/transcriptStore";
import type { TabState } from "../state/appState";
import { FOLLOWUP_SETTLE_MS, showsUpInTheChat } from "./sendPrompt";

/**
 * How long a retired agent is kept waiting for the watcher it left
 * running. Long enough for the CI run, test suite or deploy an agent
 * typically promises to report on; short enough that forgetting about a
 * tab does not leave an adapter process resident for the afternoon.
 *
 * The clock only runs while the agent says nothing at all — the moment
 * it speaks, `FOLLOWUP_SETTLE_MS` takes over and the chat is put away
 * shortly after it finishes.
 */
export const RETIRED_IDLE_LIMIT_MS = 10 * 60_000;

/** What the notification says the retired chat did. */
const CAME_BACK = "The previous chat came back — it's saved in History.";

/** A conversation taken off its tab whose agent may still have something
 *  to say. Everything needed to finish and file it, and nothing else. */
interface RetiredChat {
  readonly tabId: string;
  readonly chatId: string;
  readonly projectPath: string;
  readonly provider: ProviderId;
  readonly label: string;
  readonly providerSessionId?: string;
  historySessionId?: string;
  messages: readonly ChatMessage[];
  plan: readonly PlanEntry[];
  readonly planFilePath?: string;
  /** Set once something worth telling the user about landed. */
  spoke: boolean;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Use case — the conversations "New chat" replaced, kept only for as long
 * as their agent might still report back.
 *
 * An agent asked to watch something goes on watching it after the user
 * has moved on, and what it eventually says belongs to the chat that
 * asked, not to the one that happens to be on screen. So the agent is
 * retired rather than killed (ADR-0016), its words are folded into the
 * conversation it left, and the transcript is rewritten where the user
 * will look for it: the History row that chat already had.
 *
 * Nothing here touches `AppState`. A retired chat is off screen by
 * definition — it is a transcript being finished, not a view.
 */
export class RetiredChats {
  constructor(
    private readonly agentGateway: AgentGateway,
    private readonly transcriptStore: TranscriptStore,
    private readonly notifications: NotificationPort,
    private readonly newId: () => string,
  ) {}

  private readonly chats = new Map<string, RetiredChat>();

  /**
   * Take this conversation off its tab. One per tab: a second "New chat"
   * before the first retired agent reported puts that one away first,
   * which is also what bounds the number of live adapter processes.
   */
  retire(tab: TabState): void {
    this.close(tab.project.id);
    // An empty chat has no agent worth keeping: nothing was ever asked,
    // so nothing can be watching, and the session holds no conversation.
    if (tab.messages.length === 0) {
      void this.agentGateway.discardRetired(tab.project.id, tab.chatId).catch(nothing);
      return;
    }
    const tabId = tab.project.id;
    this.chats.set(tabId, {
      tabId,
      chatId: tab.chatId,
      projectPath: tab.project.path,
      provider: tab.project.provider,
      label: tabLabel(tab.project),
      providerSessionId: tab.project.providerSessions[tab.project.provider],
      historySessionId: tab.historySessionId,
      messages: tab.messages,
      plan: tab.plan,
      planFilePath: tab.planFilePath,
      spoke: false,
      timer: setTimeout(() => this.giveUp(tabId), RETIRED_IDLE_LIMIT_MS),
    });
  }

  /**
   * An event from an agent the user has already replaced. It folds into
   * the conversation it belongs to and restarts the settle clock — the
   * agent is mid-cycle, and a cycle nobody prompted has no completion
   * event to wait for (ADR-0011).
   */
  accept({ tabId, chatId, event }: AgentEventEnvelope): void {
    const chat = this.chats.get(tabId);
    if (!chat || chat.chatId !== chatId) return;

    chat.messages = fold(chat.messages, event);
    chat.spoke ||= showsUpInTheChat(event);
    clearTimeout(chat.timer);
    chat.timer = setTimeout(() => this.settle(tabId), FOLLOWUP_SETTLE_MS);
  }

  /**
   * The tab itself is gone. File whatever its retired chat managed to
   * say and let the agent go — the backend has already killed it, so
   * waiting out the settle would only delay the save.
   */
  forget(tabId: string): void {
    this.settle(tabId);
  }

  /** The agent finished what it came back to say. File it and tell the
   *  user, who by definition was not watching. */
  private settle(tabId: string): void {
    const chat = this.chats.get(tabId);
    if (!chat) return;
    this.close(tabId);
    if (!chat.spoke) return;
    void this.save(chat);
    void this.notifications.show(chat.label, CAME_BACK).catch(nothing);
  }

  /** The idle ceiling ran out with nothing said. The transcript is
   *  already on disk exactly as it was, so there is nothing to save and
   *  nothing to report. */
  private giveUp(tabId: string): void {
    this.close(tabId);
  }

  /** Stop tracking the chat and end its agent. */
  private close(tabId: string): void {
    const chat = this.chats.get(tabId);
    if (!chat) return;
    clearTimeout(chat.timer);
    this.chats.delete(tabId);
    void this.agentGateway.discardRetired(tabId, chat.chatId).catch(nothing);
  }

  /**
   * Rewrite the History row this conversation already had, so the report
   * lands in the chat that asked for it instead of forking a copy. A
   * chat that was never saved gets an id now — it has something to say
   * for itself at last.
   */
  private async save(chat: RetiredChat): Promise<void> {
    chat.historySessionId ??= this.newId();
    const firstUserMessage = chat.messages.find((m) => m.role === "user");
    await this.transcriptStore
      .save(chat.projectPath, {
        id: chat.historySessionId,
        title: (firstUserMessage?.text ?? "Untitled").slice(0, 80),
        savedAt: Date.now(),
        provider: chat.provider,
        projectPath: chat.projectPath,
        providerSessionId: chat.providerSessionId,
        messages: chat.messages,
        plan: chat.plan.length > 0 ? chat.plan : undefined,
        planFilePath: chat.planFilePath,
      })
      .catch(nothing); // history is best-effort, never load-bearing
  }
}

/**
 * Fold one event into a conversation nobody is looking at.
 *
 * Deliberately narrower than the live chat's handling: a cycle the agent
 * started on its own says things, thinks, runs tools and fails. What it
 * cannot do off screen is be answered, so an approval or a question
 * becomes a line saying it went unanswered rather than a card with
 * buttons nothing would deliver.
 */
function fold(
  messages: readonly ChatMessage[],
  event: AgentTurnEvent,
): readonly ChatMessage[] {
  switch (event.kind) {
    case "assistant":
      return [...messages, assistantMessage(event.text)];
    case "assistantDelta":
      return extend(messages, event.text, "assistant");
    case "thoughtDelta":
      return extend(messages, event.text, "thought");
    case "notice":
      return [...messages, infoMessage(event.message)];
    case "tool":
      return [...messages, toolMessage(event.name, event.detail)];
    case "toolCall":
      return [
        ...messages,
        toolCallMessage(event.toolCallId, event.toolKind, event.title, event.status),
      ];
    case "toolCallUpdate":
      return patchToolCall(messages, event);
    case "error":
      return [...messages, errorMessage(event.message, { context: event.context })];
    case "permission":
    case "question":
      return [
        ...messages,
        infoMessage("The agent asked for a decision after this chat was replaced."),
      ];
    default:
      // Usage, plan, mode, stage, commands, completion: bookkeeping for a
      // tab, and this conversation no longer has one.
      return messages;
  }
}

/** Streamed text: extends the last message when the role matches, exactly
 *  as the reducer does for the live chat. */
function extend(
  messages: readonly ChatMessage[],
  text: string,
  role: "assistant" | "thought",
): readonly ChatMessage[] {
  const last = messages[messages.length - 1];
  if (last?.role === role) {
    return [...messages.slice(0, -1), { ...last, text: last.text + text }];
  }
  return [
    ...messages,
    role === "assistant" ? assistantMessage(text) : thoughtMessage(text),
  ];
}

function patchToolCall(
  messages: readonly ChatMessage[],
  patch: Extract<AgentTurnEvent, { kind: "toolCallUpdate" }>,
): readonly ChatMessage[] {
  return messages.map((message) =>
    message.toolCall?.toolCallId === patch.toolCallId
      ? {
          ...message,
          ...(patch.title ? { text: patch.title } : {}),
          toolCall: mergeToolCall(message.toolCall, patch),
        }
      : message,
  );
}

function nothing(): undefined {
  return undefined;
}
