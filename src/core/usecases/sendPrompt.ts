import { modeFromAgentModeId } from "../entities/agentSettings";
import { dedupeCommands } from "../entities/command";
import { leadingCommand } from "../entities/commandConfig";
import { serversForProvider } from "../entities/mcpServer";
import {
  approvalMessage,
  assistantMessage,
  errorMessage,
  infoMessage,
  questionMessage,
  thoughtMessage,
  toolCallMessage,
  toolMessage,
  userMessage,
} from "../entities/message";
import { COMPACT_COMMAND, providerById } from "../entities/provider";
import { estimateTokens } from "../entities/tokens";
import type { AgentGateway, AgentTurnEvent } from "../ports/agentGateway";
import type { NotificationPort } from "../ports/notificationPort";
import type { TranscriptStore } from "../ports/transcriptStore";
import type { WorkspaceStore } from "../ports/workspacePort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import type { ApplyCommandConfig } from "./applyCommandConfig";
import { persistWorkspace } from "./persistWorkspace";

export type IdGenerator = () => string;

/**
 * Streamed text arrives at token rate, and every dispatch re-renders the
 * transcript. Deltas are buffered and flushed at most this often — one
 * render per frame-ish instead of one per token.
 */
const DELTA_FLUSH_MS = 33;

interface DeltaBuffer {
  role: "assistant" | "thought";
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Use case — send the user's prompt to the tab's selected agent and fold
 * the agent's event stream back into the conversation. The heart of the
 * app. After every completed turn the conversation is persisted to the
 * project's session history.
 */
export class SendPrompt {
  constructor(
    private readonly store: Store,
    private readonly agentGateway: AgentGateway,
    private readonly workspaceStore: WorkspaceStore,
    private readonly transcriptStore: TranscriptStore,
    private readonly notifications: NotificationPort,
    private readonly applyCommandConfig: ApplyCommandConfig,
    private readonly newId: IdGenerator,
  ) {}

  async execute(
    tabId: string,
    prompt: string,
    attachments: readonly string[] = [],
  ): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    const trimmed = effectiveText(prompt, attachments);
    if (!tab || trimmed === null) return;

    // Busy? Queue it — the prompt is delivered when the turn completes,
    // exactly like typing into Claude Code while it works.
    if (tab.busy) {
      this.store.dispatch({
        type: "chat/promptQueued",
        tabId,
        prompt: trimmed,
        attachments,
      });
      return;
    }

    // A slash command may carry its own mode/permission/effort. Apply it
    // first, then read the tab back: the request below must describe the
    // tab as the command leaves it, not as it was when the user typed.
    await this.applyCommandConfig.execute(tabId, trimmed);
    const configured = tabById(this.store.getState(), tabId);
    if (!configured) return;

    const { provider, path, mode, permission, model, effort } = configured.project;
    const descriptor = providerById(provider);
    const resumeSessionId = descriptor.supportsResume
      ? configured.project.providerSessions[provider]
      : undefined;

    // Stamp the prompt with the turn's settings (post-command-config, so
    // it reflects what the command switched the tab to). The outcome —
    // duration, token delta, stop reason — is patched on at completion.
    const sentAt = Date.now();
    const command = leadingCommand(trimmed);
    const message = userMessage(trimmed, attachments, {
      sentAt,
      mode,
      permission,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
      ...(command ? { command } : {}),
    });
    this.inflight.set(tabId, {
      messageId: message.id,
      sentAt,
      usedBefore: configured.usage?.used ?? 0,
      usedBeforeEstimated: configured.usage?.estimated === true,
    });

    this.store.dispatch({ type: "chat/messageAppended", tabId, message });
    // The clock comes from here, not the reducer, which stays pure.
    this.store.dispatch({ type: "chat/busyChanged", tabId, busy: true, at: sentAt });

    try {
      await this.agentGateway.startTurn(
        {
          tabId,
          provider,
          projectPath: path,
          prompt: trimmed,
          mode,
          permission,
          model,
          effort,
          attachments,
          resumeSessionId,
          mcpServers: serversForProvider(
            this.store.getState().settings.mcpServers,
            provider,
            configured.project.mcpOverrides,
          ),
        },
        (event) => this.onEvent(tabId, event),
      );
    } catch (e) {
      // A turn that never started has no outcome to stamp.
      this.inflight.delete(tabId);
      this.store.dispatch({
        type: "chat/messageAppended",
        tabId,
        message: errorMessage(describeFailure(descriptor.displayName, e)),
      });
      this.store.dispatch({ type: "chat/busyChanged", tabId, busy: false });
    }
  }

  private readonly deltas = new Map<string, DeltaBuffer>();

  /** The prompt each tab's running turn belongs to, so completion can
   *  patch it in O(1) — tab.turnStartedAt is already cleared by then. */
  private readonly inflight = new Map<
    string,
    {
      messageId: string;
      sentAt: number;
      usedBefore: number;
      usedBeforeEstimated: boolean;
    }
  >();

  private onEvent(tabId: string, event: AgentTurnEvent): void {
    // Deltas coalesce; everything else flushes first so ordering holds
    // (a tool row must land after the text that preceded it).
    if (event.kind === "assistantDelta" || event.kind === "thoughtDelta") {
      const role = event.kind === "assistantDelta" ? "assistant" : "thought";
      this.bufferDelta(tabId, role, event.text);
      return;
    }
    this.flushDeltas(tabId);

    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return;
    const provider = tab.project.provider;

    switch (event.kind) {
      case "notice":
        this.store.dispatch({
          type: "chat/messageAppended",
          tabId,
          message: infoMessage(event.message),
        });
        break;

      case "session":
        this.store.dispatch({
          type: "chat/sessionRecorded",
          tabId,
          provider,
          sessionId: event.providerSessionId,
        });
        break;

      case "assistant":
        this.store.dispatch({
          type: "chat/messageAppended",
          tabId,
          message: assistantMessage(event.text),
        });
        break;

      case "plan":
        this.store.dispatch({ type: "tab/planUpdated", tabId, plan: event.entries });
        break;

      case "usage":
        this.store.dispatch({
          type: "tab/usageUpdated",
          tabId,
          used: event.used,
          size: event.size,
        });
        break;

      case "permission":
        if (event.planMarkdown) {
          this.store.dispatch({
            type: "tab/planMarkdownUpdated",
            tabId,
            markdown: event.planMarkdown,
            filePath: event.planFilePath,
          });
        }
        this.store.dispatch({
          type: "chat/messageAppended",
          tabId,
          message: approvalMessage(
            event.title,
            event.requestId,
            event.options,
            event.planMarkdown,
            event.toolCallId,
          ),
        });
        break;

      case "question":
        this.store.dispatch({
          type: "chat/messageAppended",
          tabId,
          message: questionMessage(event.message, event.requestId, event.questions),
        });
        // The agent is now blocked on a person, so get their eyes on it
        // even if they have wandered to another tab.
        this.requestAttention(tabId);
        break;

      case "commands":
        this.store.dispatch({
          type: "tab/commandsUpdated",
          tabId,
          commands: dedupeCommands(
            event.commands.map((c) => ({ ...c, source: "builtin" as const })),
          ),
        });
        break;

      case "tool":
        this.store.dispatch({
          type: "chat/messageAppended",
          tabId,
          message: toolMessage(event.name, event.detail),
        });
        break;

      case "toolCall":
        this.store.dispatch({
          type: "chat/messageAppended",
          tabId,
          message: toolCallMessage(
            event.toolCallId,
            event.toolKind,
            event.title,
            event.status,
          ),
        });
        break;

      case "toolCallUpdate":
        this.store.dispatch({
          type: "chat/toolCallUpdated",
          tabId,
          toolCallId: event.toolCallId,
          patch: {
            status: event.status,
            title: event.title,
            content: event.content,
            locations: event.locations,
          },
        });
        break;

      case "modeChanged": {
        // Keep the composer's picker honest when the agent switches its
        // own mode (e.g. leaving plan mode after an approved plan).
        const mapped = modeFromAgentModeId(event.modeId);
        if (mapped && mapped !== tab.project.mode) {
          this.store.dispatch({ type: "tab/modeChanged", tabId, mode: mapped });
        }
        break;
      }

      case "sessionStage":
        this.store.dispatch({
          type: "tab/sessionStageChanged",
          tabId,
          stage: event.stage === "ready" ? undefined : event.stage,
        });
        break;

      case "error":
        this.store.dispatch({
          type: "chat/messageAppended",
          tabId,
          message: errorMessage(event.message, {
            context: event.context,
            stderrTail: event.stderrTail,
          }),
        });
        this.store.dispatch({ type: "tab/sessionStageChanged", tabId, stage: undefined });
        break;

      case "completed": {
        if (event.providerSessionId) {
          this.store.dispatch({
            type: "chat/sessionRecorded",
            tabId,
            provider,
            sessionId: event.providerSessionId,
          });
        }
        if (event.isError && event.result) {
          this.store.dispatch({
            type: "chat/messageAppended",
            tabId,
            message: errorMessage(event.result),
          });
        }
        // A turn cut short by limits is not a success to pass off
        // silently — say so where the user will see it.
        if (
          event.stopReason === "max_tokens" ||
          event.stopReason === "max_turn_requests"
        ) {
          this.store.dispatch({
            type: "chat/messageAppended",
            tabId,
            message: infoMessage(
              event.stopReason === "max_tokens"
                ? "The reply was cut short: the agent hit its output-token limit."
                : "The turn stopped early: the agent hit its per-turn request limit.",
            ),
          });
        }
        this.store.dispatch({ type: "chat/approvalsCancelled", tabId });
        this.store.dispatch({ type: "chat/busyChanged", tabId, busy: false });
        this.store.dispatch({ type: "tab/sessionStageChanged", tabId, stage: undefined });
        // A cancel already has the user's full attention.
        if (event.stopReason !== "cancelled") this.requestAttention(tabId);
        this.estimateUsageIfUnreported(tabId);
        // After the estimate (so the delta has an endpoint) and before
        // the save (so the transcript carries the completed meta).
        this.completeTurnMeta(tabId, event.stopReason);
        void persistWorkspace(this.store.getState(), this.workspaceStore);
        void this.saveTranscript(tabId);
        this.autoCompactIfNeeded(tabId);
        this.drainQueue(tabId);
        break;
      }
    }
  }

  private bufferDelta(tabId: string, role: "assistant" | "thought", text: string): void {
    const existing = this.deltas.get(tabId);
    if (existing && existing.role !== role) this.flushDeltas(tabId);
    const buffer = this.deltas.get(tabId);
    if (buffer) {
      buffer.text += text;
      return;
    }
    this.deltas.set(tabId, {
      role,
      text,
      timer: setTimeout(() => this.flushDeltas(tabId), DELTA_FLUSH_MS),
    });
  }

  private flushDeltas(tabId: string): void {
    const buffer = this.deltas.get(tabId);
    if (!buffer) return;
    this.deltas.delete(tabId);
    clearTimeout(buffer.timer);

    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return;
    const last = tab.messages[tab.messages.length - 1];
    if (last?.role === buffer.role) {
      if (buffer.role === "assistant") {
        this.store.dispatch({ type: "chat/assistantDelta", tabId, text: buffer.text });
      } else {
        this.store.dispatch({ type: "chat/thoughtDelta", tabId, text: buffer.text });
      }
      return;
    }
    this.store.dispatch({
      type: "chat/messageAppended",
      tabId,
      message:
        buffer.role === "assistant"
          ? assistantMessage(buffer.text)
          : thoughtMessage(buffer.text),
    });
  }

  /**
   * Get the user's eyes on a finished tab: flag it in the tab bar when
   * it isn't the active one, and raise an OS notification (the adapter
   * suppresses it when the user is demonstrably already watching).
   */
  private requestAttention(tabId: string): void {
    const state = this.store.getState();
    const tab = tabById(state, tabId);
    if (!tab) return;

    const tabActive = state.activeTabId === tabId;
    if (!tabActive) {
      this.store.dispatch({ type: "tab/attentionRequested", tabId });
    }
    void this.notifications
      .turnCompleted(
        tab.project.name,
        providerById(tab.project.provider).displayName,
        tabActive,
      )
      .catch(() => undefined); // notifications are best-effort
  }

  /** Drop a message the user queued and then thought better of. */
  removeQueued(tabId: string, index: number): void {
    this.store.dispatch({ type: "chat/queueRemoved", tabId, index });
  }

  /**
   * Re-send the last user prompt — the "Retry" on an error bubble. The
   * failed exchange stays in the transcript; retrying appends a fresh
   * attempt rather than rewriting history.
   */
  async retryLast(tabId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab || tab.busy) return;
    const lastUser = [...tab.messages].reverse().find((m) => m.role === "user");
    if (!lastUser) return;
    await this.execute(tabId, lastUser.text, lastUser.attachments ?? []);
  }

  /**
   * Deliver the next queued prompt, if the tab is idle. When auto-compact
   * claimed the turn instead, the queue simply drains after that turn.
   */
  private drainQueue(tabId: string): void {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab || tab.busy) return;
    const next = tab.queued[0];
    if (!next) return;
    this.store.dispatch({ type: "chat/queueShifted", tabId });
    void this.execute(tabId, next.prompt, next.attachments);
  }

  /**
   * When the agent never sent a `usage_update`, keep the context gauge
   * (and auto-compact's trigger) alive with a client-side estimate. A
   * real report — present and not itself an estimate — always wins.
   */
  private estimateUsageIfUnreported(tabId: string): void {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab || (tab.usage && !tab.usage.estimated)) return;
    this.store.dispatch({
      type: "tab/usageUpdated",
      tabId,
      used: estimateTokens(tab.messages),
      size: providerById(tab.project.provider).contextWindow,
      estimated: true,
    });
  }

  /** Compact now — the user was asked and chose to spend it. */
  async compactNow(tabId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return;
    this.store.dispatch({ type: "tab/contextFullChanged", tabId, percent: undefined });
    await this.execute(tabId, COMPACT_COMMAND[tab.project.provider]);
  }

  /** Keep going as is. The question returns on the next turn if the
   *  context is still over the ceiling — it is not silenced for good. */
  dismissContextFull(tabId: string): void {
    this.store.dispatch({ type: "tab/contextFullChanged", tabId, percent: undefined });
  }

  /**
   * Act on a nearly-full context window, per the user's policy.
   *
   * Compacting is not the obvious win it looks like: it costs a full pass
   * over the context plus a cache re-write on the turn after. Starting a
   * new chat costs nothing. Which is right depends on whether the
   * conversation still matters, so "ask" hands that back to the user
   * rather than spending on their behalf.
   *
   * Guarded against loops: never triggered by the compact turn itself.
   */
  private autoCompactIfNeeded(tabId: string): void {
    const state = this.store.getState();
    const tab = tabById(state, tabId);
    if (!tab?.usage) return;
    const policy = state.settings.autoCompact;
    if (policy === "off") return;
    if (tab.usage.used / tab.usage.size < state.settings.autoCompactThreshold) {
      // Dropped back under the ceiling (a compaction, or a new session):
      // the question no longer stands.
      if (tab.contextFullPercent !== undefined) {
        this.store.dispatch({
          type: "tab/contextFullChanged",
          tabId,
          percent: undefined,
        });
      }
      return;
    }

    const compactCommand = COMPACT_COMMAND[tab.project.provider];
    const lastUserMessage = [...tab.messages].reverse().find((m) => m.role === "user");
    if (lastUserMessage?.text === compactCommand) return; // that WAS the compact turn

    const percent = Math.round((tab.usage.used / tab.usage.size) * 100);
    if (policy === "ask") {
      this.store.dispatch({ type: "tab/contextFullChanged", tabId, percent });
      return;
    }
    this.store.dispatch({
      type: "chat/messageAppended",
      tabId,
      message: infoMessage(
        `Context ${percent}% full — compacting the conversation automatically.`,
      ),
    });
    void this.execute(tabId, compactCommand);
  }

  /**
   * Stamp the turn's outcome onto the prompt that started it: duration,
   * the context-usage delta, and any abnormal stop reason. Exactly one
   * dispatch, replacing exactly one message object.
   */
  private completeTurnMeta(tabId: string, stopReason?: string): void {
    const entry = this.inflight.get(tabId);
    if (!entry) return;
    this.inflight.delete(tabId);

    const usage = tabById(this.store.getState(), tabId)?.usage;
    const delta = usage ? usage.used - entry.usedBefore : undefined;
    // A negative delta means compaction shrank the context mid-turn — a
    // token count would be noise, so only the duration is kept.
    const tokens = delta !== undefined && delta >= 0 ? delta : undefined;
    const estimated =
      tokens !== undefined && (entry.usedBeforeEstimated || usage?.estimated === true);

    this.store.dispatch({
      type: "chat/turnMetaCompleted",
      tabId,
      messageId: entry.messageId,
      patch: {
        durationMs: Date.now() - entry.sentAt,
        ...(tokens !== undefined ? { tokens } : {}),
        ...(estimated ? { tokensEstimated: true } : {}),
        ...(stopReason && stopReason !== "end_turn" ? { stopReason } : {}),
      },
    });
  }

  /** Persist the conversation so it appears in the History panel. */
  private async saveTranscript(tabId: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab || tab.messages.length === 0) return;

    let sessionId = tab.historySessionId;
    if (!sessionId) {
      sessionId = this.newId();
      this.store.dispatch({ type: "chat/historySessionAssigned", tabId, sessionId });
    }

    const firstUserMessage = tab.messages.find((m) => m.role === "user");
    await this.transcriptStore
      .save(tab.project.path, {
        id: sessionId,
        title: (firstUserMessage?.text ?? "Untitled").slice(0, 80),
        savedAt: Date.now(),
        provider: tab.project.provider,
        projectPath: tab.project.path,
        // Recorded by the "session" event earlier in this same turn, so
        // it is already in the tab by the time the save runs.
        providerSessionId: tab.project.providerSessions[tab.project.provider],
        messages: tab.messages,
        plan: tab.plan.length > 0 ? tab.plan : undefined,
        planFilePath: tab.planFilePath, // path only — content read on reopen
      })
      .catch(() => undefined); // history is best-effort, never load-bearing
  }
}

/**
 * The text to send: the trimmed prompt, a stand-in when only files were
 * attached, or null when there is nothing to send at all.
 */
function effectiveText(prompt: string, attachments: readonly string[]): string | null {
  const trimmed = prompt.trim();
  if (trimmed.length > 0) return trimmed;
  if (attachments.length > 0) return "Please review the attached files.";
  return null;
}

function describeFailure(providerName: string, e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e);
  return `Could not start ${providerName}: ${detail}. Is its CLI installed and on your PATH?`;
}
