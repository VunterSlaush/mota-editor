import { modeFromAgentModeId } from "../entities/agentSettings";
import { dedupeCommands } from "../entities/command";
import { leadingCommand } from "../entities/commandConfig";
import {
  CREATE_EXTENSION_COMMAND,
  createExtensionPrompt,
} from "../entities/createExtensionGuide";
import { expandPromptCommand, findExtensionCommand } from "../entities/extension";
import {
  AUTH_REQUIRED_CONTEXT,
  approvalMessage,
  assistantMessage,
  type ChatMessage,
  errorMessage,
  infoMessage,
  questionMessage,
  thoughtMessage,
  toolCallMessage,
  toolMessage,
  userMessage,
} from "../entities/message";
import { tabLabel } from "../entities/project";
import { COMPACT_COMMAND, contextWindowFor, providerById } from "../entities/provider";
import { estimateTokens } from "../entities/tokens";
import type { AgentGateway, AgentTurnEvent } from "../ports/agentGateway";
import type { NotificationPort } from "../ports/notificationPort";
import type { PersistedTranscript, TranscriptStore } from "../ports/transcriptStore";
import type { WorkspaceStore } from "../ports/workspacePort";
import { type TabState, tabById } from "../state/appState";
import type { Store } from "../state/store";
import { agentServers } from "./agentServers";
import type { ApplyCommandConfig } from "./applyCommandConfig";
import { persistWorkspace } from "./persistWorkspace";
import { declineParkedPlan } from "./planApproval";
import type { RunExtensionCommand } from "./runExtensionCommand";
import { startNewChat } from "./startNewChat";

export type IdGenerator = () => string;

/**
 * Streamed text arrives at token rate, and every dispatch re-renders the
 * transcript. Deltas are buffered and flushed at most this often — one
 * render per frame-ish instead of one per token.
 */
const DELTA_FLUSH_MS = 33;

/**
 * A follow-up the agent starts on its own has no end to wait for: a stop
 * reason answers a prompt, and this cycle answers none. A stretch of
 * quiet this long is taken as the end of one — long enough to outlast
 * the gap between a tool call and its result, short enough that the
 * transcript is saved while the user is still around to see it.
 *
 * 2s was the first guess and it was too short. Driving the real ACP
 * adapter directly (a background `sleep`, then the follow-up it triggers)
 * put the gaps *inside* one cycle at 2.2s and 2.7s: the cycle opens by
 * reading the task's output file, and the model's think time between a
 * tool result and its next word clears 2s routinely. Every one of those
 * gaps settled the stretch early — three notifications, three transcript
 * saves and three busy flickers for one follow-up, with a queued prompt
 * free to drain into the middle of it. 8s clears the observed spread with
 * room to spare and still lands the transcript promptly.
 */
export const FOLLOWUP_SETTLE_MS = 8_000;

interface DeltaBuffer {
  role: "assistant" | "thought";
  text: string;
  timer: ReturnType<typeof setTimeout>;
}

/** One agent-initiated stretch, open until the events stop coming. */
interface Followup {
  timer: ReturnType<typeof setTimeout>;
  /** Something the user would want to look at landed, not just usage. */
  notable: boolean;
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
    private readonly extensionCommands?: RunExtensionCommand,
  ) {
    agentGateway.subscribeAgentInitiated((tabId, event) =>
      this.onAgentInitiated(tabId, event),
    );
  }

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

    // Parked on a plan? The message IS the answer to it. Turn the plan
    // down and stop the turn first, so this prompt starts a fresh one
    // instead of racing the turn still open on the agent's side.
    await declineParkedPlan(this.store, this.agentGateway, tabId);

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

    // A command an EXTENSION contributed never reaches the agent. The
    // typed form stays in the transcript either way; a prompt-template
    // command swaps the OUTGOING text, a programmatic one is routed to
    // the extension process instead of starting a turn at all.
    const extensionHit = command
      ? findExtensionCommand(this.store.getState().extensions, provider, command)
      : null;
    if (extensionHit && this.extensionCommands) {
      const args = trimmed.slice(command?.length ?? 0).trim();
      if (extensionHit.command.kind === "programmatic") {
        this.store.dispatch({
          type: "chat/messageAppended",
          tabId,
          message: userMessage(trimmed, attachments, {
            sentAt,
            mode,
            permission,
            ...(command ? { command } : {}),
          }),
        });
        await this.extensionCommands.execute(tabId, extensionHit, args);
        return;
      }
    }
    const commandArgs = trimmed.slice(command?.length ?? 0).trim();
    const outgoing =
      command === CREATE_EXTENSION_COMMAND
        ? createExtensionPrompt(commandArgs)
        : extensionHit?.command.kind === "prompt" && extensionHit.command.template
          ? expandPromptCommand(extensionHit.command.template, commandArgs)
          : trimmed;

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

    const turn = (this.generation.get(tabId) ?? 0) + 1;
    this.generation.set(tabId, turn);

    const request = {
      tabId,
      provider,
      projectPath: path,
      prompt: outgoing,
      mode,
      permission,
      model,
      effort,
      attachments,
      resumeSessionId,
      mcpServers: agentServers(
        this.store.getState(),
        provider,
        configured.project.mcpOverrides,
      ),
    };

    let failure = await this.tryStart(tabId, request, turn);
    // The agent still had a turn open in a tab this app believes is
    // idle. That is a desync, not a busy agent — the composer would have
    // queued the prompt instead of sending it if we thought otherwise —
    // and left alone it makes the tab permanently unusable. Stopping the
    // stale turn and sending once more is what the user was asking for
    // anyway; it is said out loud because something was killed to do it.
    if (failure !== null && isStaleTurnFailure(failure)) {
      await this.agentGateway.cancelTurn(tabId).catch(() => undefined);
      this.store.dispatch({
        type: "chat/messageAppended",
        tabId,
        message: infoMessage(
          "This tab still had a turn open with the agent. Mota stopped it and sent your message.",
        ),
      });
      failure = await this.tryStart(tabId, request, turn);
    }
    if (failure === null) return;

    // A turn that never started has no outcome to stamp.
    this.inflight.delete(tabId);
    this.store.dispatch({
      type: "chat/messageAppended",
      tabId,
      message: errorMessage(describeFailure(descriptor.displayName, failure)),
    });
    this.store.dispatch({ type: "chat/busyChanged", tabId, busy: false });
  }

  /** Start the turn; the failure, or null when it went. */
  private async tryStart(
    tabId: string,
    request: Parameters<AgentGateway["startTurn"]>[0],
    turn: number,
  ): Promise<unknown> {
    try {
      await this.agentGateway.startTurn(request, (event) =>
        this.onEvent(tabId, event, turn),
      );
      return null;
    } catch (e) {
      return e;
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

  /**
   * Which turn a tab is on. A cancelled turn's `completed` can arrive
   * after the next one has started — declining a plan makes that the
   * normal case, not a rarity — and it would report the old turn's
   * outcome as the new one's, and mark a running tab idle.
   */
  private readonly generation = new Map<string, number>();

  /** Agent-initiated stretches, by tab. See `onAgentInitiated`. */
  private readonly followups = new Map<string, Followup>();

  private onEvent(tabId: string, event: AgentTurnEvent, turn: number): void {
    if (turn !== this.generation.get(tabId)) return; // a superseded turn's tail
    this.dispatchEvent(tabId, event);
  }

  /**
   * An event with no turn of ours in flight: the agent came back on its
   * own — a background task it was watching finished, or a wake-up it
   * scheduled fired. It folds into the conversation exactly like a
   * turn's own events, because to the reader it IS the agent talking.
   *
   * The tab goes busy for it — the agent really is working, and Stop has
   * to be reachable while it does — but nothing will ever announce the
   * end: a stop reason answers a prompt, and this cycle answers none. So
   * the flag comes down on quiet, in `settleFollowup`, rather than on a
   * completion that is never coming.
   */
  private onAgentInitiated(tabId: string, event: AgentTurnEvent): void {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return;

    const open = this.followups.get(tabId);
    if (!open && !tab.busy) {
      this.store.dispatch({
        type: "chat/busyChanged",
        tabId,
        busy: true,
        at: Date.now(),
      });
    }
    this.dispatchEvent(tabId, event);

    if (open) clearTimeout(open.timer);
    this.followups.set(tabId, {
      notable: (open?.notable ?? false) || showsUpInTheChat(event),
      timer: setTimeout(() => this.settleFollowup(tabId), FOLLOWUP_SETTLE_MS),
    });
  }

  /**
   * The agent has gone quiet again. Let the tab go idle, then save what
   * was said and get the user's eyes on it — a follow-up lands with
   * nobody watching by definition, which is the whole reason the agent
   * scheduled one.
   */
  private settleFollowup(tabId: string): void {
    const open = this.followups.get(tabId);
    if (!open) return;
    this.followups.delete(tabId);
    this.flushDeltas(tabId);
    // A turn of ours started in the meantime: it owns the busy flag now,
    // and its own completion does the telling, saving and draining.
    if (this.inflight.has(tabId)) return;

    this.store.dispatch({ type: "chat/busyChanged", tabId, busy: false });
    // Anything typed while the follow-up held the tab queued behind it,
    // and no completion is coming to release it.
    this.drainQueue(tabId);
    // A stretch of nothing but usage updates is not news.
    if (!open.notable) return;
    this.requestAttention(tabId);
    void persistWorkspace(this.store.getState(), this.workspaceStore);
    void this.saveTranscript(tabId);
  }

  private dispatchEvent(tabId: string, event: AgentTurnEvent): void {
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
          message: approvalMessage(event.title, {
            requestId: event.requestId,
            options: event.options,
            planMarkdown: event.planMarkdown,
            toolCallId: event.toolCallId,
            isPlan: event.isPlan,
          }),
        });
        // A plan parks the turn. The agent is blocked on the user either
        // way, but only a plan is a place to say something back, so the
        // composer must be free rather than queueing behind a turn that
        // is going nowhere until it is answered.
        if (event.isPlan) {
          this.store.dispatch({ type: "chat/busyChanged", tabId, busy: false });
        }
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
        const mapped = modeFromAgentModeId(event.modeId, tab.project.mode);
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
          // A login failure is tagged rather than left as prose: the
          // transcript offers Sign in beside it, which is the whole
          // difference between "go read this" and "fix it".
          const isAuthFailure = event.stopReason === "auth_required";
          this.store.dispatch({
            type: "chat/messageAppended",
            tabId,
            message: errorMessage(
              event.result,
              isAuthFailure ? { context: AUTH_REQUIRED_CONTEXT } : undefined,
            ),
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
        // What the user calls the tab, which is the whole point of a
        // notification: which of my tasks just finished?
        tabLabel(tab.project),
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
      size: contextWindowFor(tab.project.provider, tab.project.model),
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
   * Compacting is not the win it looks like: measured on real logs it
   * costs about what it saves. What actually drives the bill is
   * conversation LENGTH — every turn re-sends the whole conversation, so
   * a late turn costs several times an early one. Only a new chat resets
   * that, which is why it is offered as an automatic policy and not just
   * a button. It is also the one option that loses something (the agent
   * forgets), so "ask" hands the choice back rather than spending — or
   * forgetting — on the user's behalf.
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
    if (policy === "newChat") {
      // Safe because the transcript was already saved above: this clears
      // the screen, but the conversation is in History either way.
      //
      // The notice goes in AFTER the reset, not before — starting the new
      // chat clears the messages, so anything said first is wiped by the
      // very action it was explaining. A chat that emptied itself with no
      // reason given reads as a bug, not as the setting the user chose.
      void startNewChat(this.store, this.agentGateway, tabId).then(() => {
        this.store.dispatch({
          type: "chat/messageAppended",
          tabId,
          message: infoMessage(
            `The previous chat filled its context (${percent}%) and is saved in History. This one starts fresh.`,
          ),
        });
      });
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
    let earlier: readonly ChatMessage[] = [];
    if (!sessionId) {
      const resumed = await this.restoredTranscript(tab);
      sessionId = resumed?.id ?? this.newId();
      earlier = resumed?.messages ?? [];
      this.store.dispatch({ type: "chat/historySessionAssigned", tabId, sessionId });
    }

    const messages = [...earlier, ...tab.messages];
    const firstUserMessage = messages.find((m) => m.role === "user");
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
        messages,
        plan: tab.plan.length > 0 ? tab.plan : undefined,
        planFilePath: tab.planFilePath, // path only — content read on reopen
      })
      .catch(() => undefined); // history is best-effort, never load-bearing
  }

  /**
   * The transcript a restored tab may rejoin: the one it was writing to
   * before the app was reloaded, IF the agent is still in that same
   * conversation. Null when there is nothing to rejoin — the caller then
   * starts a new one.
   *
   * The frontend forgets its chat on every reload while the backend
   * session lives on, which in development is several times an hour.
   * Without this the same conversation is cut into a fresh History entry
   * each time — the "every prompt becomes a history item" bug. The
   * session ids must MATCH: a genuine restart boots a new agent session,
   * and appending a different conversation to this transcript (or worse,
   * overwriting it with only the messages since the reload) would lose
   * the one it holds.
   */
  private async restoredTranscript(tab: TabState): Promise<PersistedTranscript | null> {
    const live = tab.project.providerSessions[tab.project.provider];
    if (!tab.restoredHistorySessionId || !live) return null;
    const stored = await this.transcriptStore
      .load(tab.project.path, tab.restoredHistorySessionId)
      .catch(() => null);
    return stored?.providerSessionId === live ? stored : null;
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

/**
 * Whether this event is something the user would want to be told about.
 * Usage and session bookkeeping are not: a follow-up that only reported
 * a token count is not worth a notification and a tab-bar dot.
 */
function showsUpInTheChat(event: AgentTurnEvent): boolean {
  switch (event.kind) {
    case "assistant":
    case "assistantDelta":
    case "thoughtDelta":
    case "tool":
    case "toolCall":
    case "permission":
    case "question":
    case "error":
      return true;
    default:
      return false;
  }
}

/**
 * Whether a start failed because the backend still holds a turn for this
 * tab. Matched on the backend's words because the failure crosses the
 * boundary as a message and nothing else — the phrase is the contract,
 * and this test is what keeps the two ends honest about it.
 */
export function isStaleTurnFailure(e: unknown): boolean {
  const message = e instanceof Error ? e.message : String(e);
  return message.includes("turn is already running");
}

function describeFailure(providerName: string, e: unknown): string {
  const detail = e instanceof Error ? e.message : String(e);
  return `Could not start ${providerName}: ${detail}. Is its CLI installed and on your PATH?`;
}
