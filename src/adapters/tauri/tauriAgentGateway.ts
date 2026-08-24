import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { McpServerSpec } from "../../core/entities/mcpServer";
import type { SubtaskScope } from "../../core/entities/subtask";
import type {
  AgentGateway,
  AgentTurnEvent,
  AgentTurnRequest,
} from "../../core/ports/agentGateway";

/**
 * Interface adapter — implements the core's AgentGateway port by calling
 * the Tauri backend, which spawns the provider's CLI in headless mode.
 * This is the only frontend file that knows agent turns run over Tauri IPC.
 */

/** Wire shape emitted by the Rust backend (see src-tauri/agent-core). */
interface WireEvent {
  tabId: string;
  event:
    | { type: "sessionStarted"; providerSessionId: string }
    | { type: "notice"; message: string }
    | { type: "assistantMessage"; text: string }
    | { type: "assistantDelta"; text: string }
    | { type: "userDelta"; text: string }
    | { type: "thoughtDelta"; text: string }
    | {
        type: "planUpdated";
        entries: { content: string; priority: string; status: string }[];
      }
    | { type: "usageUpdated"; used: number; size: number }
    | { type: "toolUse"; name: string; detail: string }
    | { type: "toolCall"; id: string; kind: string; title: string; status: string }
    | {
        type: "toolCallUpdate";
        id: string;
        status: string | null;
        title: string | null;
        content: WireToolContent[];
        locations: { path: string; line: number | null }[];
      }
    | { type: "modeChanged"; modeId: string }
    | { type: "sessionStage"; stage: string }
    | { type: "commandsUpdated"; commands: { name: string; description: string }[] }
    | {
        type: "permissionRequested";
        requestId: string;
        title: string;
        options: { optionId: string; name: string; kind: string }[];
        planMarkdown: string | null;
        planFilePath: string | null;
        toolCallId: string | null;
        isPlan: boolean;
      }
    | {
        type: "questionAsked";
        requestId: string;
        message: string;
        questions: {
          field: string;
          header: string | null;
          text: string;
          options: { value: string; label: string; description: string | null }[];
          multiSelect: boolean;
          customField: string | null;
        }[];
      }
    | {
        type: "errorOccurred";
        message: string;
        context: string | null;
        stderrTail: string | null;
      }
    | {
        type: "turnCompleted";
        result: string | null;
        providerSessionId: string | null;
        isError: boolean;
        stopReason: string | null;
      };
}

/** Tool-call content block as the backend serializes it. */
type WireToolContent =
  | { type: "text"; text: string }
  | { type: "diff"; path: string; oldText: string | null; newText: string }
  | { type: "terminal"; terminalId: string };

export class TauriAgentGateway implements AgentGateway {
  /**
   * One process-wide listener routes events to the active handler per
   * tab. Registering a listener per turn leaked them (a cancelled turn
   * never saw the `completed` that tore its listener down) and a leaked
   * one folded every later event twice.
   */
  private readonly handlers = new Map<string, (event: AgentTurnEvent) => void>();
  private sessionHandler: ((tabId: string, event: AgentTurnEvent) => void) | null = null;
  private agentInitiatedHandler: ((tabId: string, event: AgentTurnEvent) => void) | null =
    null;
  /**
   * Tabs replaying a history session. A replay streams through its own
   * temporary listener AND this one, so the agent-initiated lane has to
   * stand down or every replayed message lands in the live chat twice.
   */
  private readonly replaying = new Set<string>();
  private listening: Promise<UnlistenFn> | null = null;

  private async ensureListener(): Promise<void> {
    this.listening ??= listen<WireEvent>("agent-event", ({ payload }) => {
      const event = toDomainEvent(payload.event);
      const handler = this.handlers.get(payload.tabId);
      if (handler) {
        handler(event);
        if (event.kind === "completed") this.handlers.delete(payload.tabId);
        return;
      }
      // No turn in flight: session-level events (warm-up stages, mode
      // switches, notices, the id of the session that just booted) have
      // their own subscriber — a respawn notice in particular is emitted
      // by warm-up, which is exactly when no turn is running.
      if (
        event.kind === "sessionStage" ||
        event.kind === "modeChanged" ||
        event.kind === "notice" ||
        event.kind === "session"
      ) {
        this.sessionHandler?.(payload.tabId, event);
        return;
      }
      // Anything else with no turn of ours in flight is the agent
      // speaking on its own — a follow-up cycle after a background task
      // it was watching finished. Dropping it, as this used to, is what
      // made "I'll check back when CI is done" never arrive.
      if (!this.replaying.has(payload.tabId)) {
        this.agentInitiatedHandler?.(payload.tabId, event);
      }
    });
    await this.listening;
  }

  subscribeSessionEvents(onEvent: (tabId: string, event: AgentTurnEvent) => void): void {
    this.sessionHandler = onEvent;
    // Warm-up stages can arrive before any turn ever starts.
    void this.ensureListener();
  }

  subscribeAgentInitiated(onEvent: (tabId: string, event: AgentTurnEvent) => void): void {
    this.agentInitiatedHandler = onEvent;
    // A follow-up can land in any quiet stretch, including before this
    // tab's first turn — the listener has to be up either way.
    void this.ensureListener();
  }

  async startTurn(
    request: AgentTurnRequest,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {
    await this.ensureListener();
    this.handlers.set(request.tabId, onEvent);

    try {
      await invoke("start_turn", {
        args: {
          tabId: request.tabId,
          providerId: request.provider,
          projectPath: request.projectPath,
          prompt: request.prompt,
          mode: request.mode,
          permission: request.permission,
          model: request.model ?? null,
          effort: request.effort ?? null,
          attachments: [...request.attachments],
          resumeSessionId: request.resumeSessionId ?? null,
          mcpServers: toWireServers(request.mcpServers),
          subtask: request.subtask ?? null,
          delegateTo: request.delegateTo ?? null,
          handoff: request.handoff ?? null,
        },
      });
    } catch (e) {
      this.handlers.delete(request.tabId);
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  async cancelTurn(tabId: string): Promise<void> {
    // Stopping means "stop": whatever the turn still emits while dying
    // (deltas, tool use) must not fold into the chat after the "Turn
    // cancelled." notice — but the turn's real `completed` must still
    // land, or pending approval/question cards stay answerable and busy
    // teardown never runs. Filter instead of deleting outright.
    const original = this.handlers.get(tabId);
    if (original) {
      this.handlers.set(tabId, (event) => {
        if (event.kind === "completed") original(event);
      });
    }
    await invoke("cancel_turn", { tabId });
  }

  async respondPermission(
    tabId: string,
    requestId: string,
    optionId: string,
  ): Promise<void> {
    await invoke("respond_permission", { tabId, requestId, optionId });
  }

  async respondQuestion(
    tabId: string,
    requestId: string,
    answers: Readonly<Record<string, string>>,
  ): Promise<void> {
    await invoke("respond_question", { tabId, requestId, answers });
  }

  async endSession(tabId: string): Promise<void> {
    await invoke("end_session", { tabId });
  }

  async readTerminalOutput(
    tabId: string,
    terminalId: string,
  ): Promise<{ output: string; truncated: boolean; exited: boolean } | null> {
    return invoke("get_terminal_output", { tabId, terminalId });
  }

  async warmSession(
    tabId: string,
    provider: string,
    projectPath: string,
    model?: string,
    effort?: string,
    mcpServers?: readonly McpServerSpec[],
    subtask?: SubtaskScope,
  ): Promise<void> {
    await invoke("warm_session", {
      args: {
        tabId,
        providerId: provider,
        projectPath,
        model: model ?? null,
        effort: effort ?? null,
        mcpServers: toWireServers(mcpServers),
        subtask: subtask ?? null,
      },
    });
  }

  async listNativeSessions(
    tabId: string,
    provider: string,
    projectPath: string,
    model?: string,
    effort?: string,
    mcpServers?: readonly McpServerSpec[],
    subtask?: SubtaskScope,
  ): Promise<{ sessionId: string; title?: string; updatedAt?: string }[] | null> {
    // Null when no live session exists — the shell never boots an
    // agent process just to answer the History panel.
    return invoke("list_agent_sessions", {
      args: {
        tabId,
        providerId: provider,
        projectPath,
        model: model ?? null,
        effort: effort ?? null,
        mcpServers: toWireServers(mcpServers),
        subtask: subtask ?? null,
      },
    });
  }

  async loadNativeSession(
    request: {
      tabId: string;
      provider: string;
      projectPath: string;
      model?: string;
      effort?: string;
      sessionId: string;
      mcpServers?: readonly McpServerSpec[];
      subtask?: SubtaskScope;
      preferResume?: boolean;
    },
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<{ replayed: boolean }> {
    // A stale per-tab handler (e.g. left by a cancelled headless turn)
    // must not also fold the replay into the live chat, and neither must
    // the agent-initiated lane, which is exactly where a turn-less
    // stream of events would otherwise go.
    this.handlers.delete(request.tabId);
    this.replaying.add(request.tabId);
    const unlisten = await listen<WireEvent>("agent-event", ({ payload }) => {
      if (payload.tabId !== request.tabId) return;
      onEvent(toDomainEvent(payload.event));
    });
    try {
      // The replay streams through the listener before this resolves.
      const replayed = await invoke<boolean>("load_agent_session", {
        args: {
          tabId: request.tabId,
          providerId: request.provider,
          projectPath: request.projectPath,
          model: request.model ?? null,
          effort: request.effort ?? null,
          sessionId: request.sessionId,
          mcpServers: toWireServers(request.mcpServers),
          subtask: request.subtask ?? null,
          preferResume: request.preferResume ?? false,
        },
      });
      return { replayed };
    } finally {
      unlisten();
      this.replaying.delete(request.tabId);
    }
  }
}

/**
 * Servers cross the boundary as a plain array — `readonly` is a
 * TypeScript idea, and Tauri serializes what it is given.
 */
function toWireServers(servers: readonly McpServerSpec[] | undefined) {
  return (servers ?? []).map((server) => ({
    name: server.name,
    command: server.command,
    args: [...server.args],
    env: { ...server.env },
  }));
}

function toDomainEvent(wire: WireEvent["event"]): AgentTurnEvent {
  switch (wire.type) {
    case "sessionStarted":
      return { kind: "session", providerSessionId: wire.providerSessionId };
    case "notice":
      return { kind: "notice", message: wire.message };
    case "assistantMessage":
      return { kind: "assistant", text: wire.text };
    case "assistantDelta":
      return { kind: "assistantDelta", text: wire.text };
    case "userDelta":
      return { kind: "userDelta", text: wire.text };
    case "thoughtDelta":
      return { kind: "thoughtDelta", text: wire.text };
    case "planUpdated":
      return { kind: "plan", entries: wire.entries };
    case "usageUpdated":
      return { kind: "usage", used: wire.used, size: wire.size };
    case "permissionRequested":
      return {
        kind: "permission",
        requestId: wire.requestId,
        title: wire.title,
        options: wire.options,
        planMarkdown: wire.planMarkdown ?? undefined,
        planFilePath: wire.planFilePath ?? undefined,
        toolCallId: wire.toolCallId ?? undefined,
        isPlan: wire.isPlan,
      };
    case "questionAsked":
      // Rust serializes absent values as null; the core models them as
      // optional, so they are dropped rather than carried through.
      return {
        kind: "question",
        requestId: wire.requestId,
        message: wire.message,
        questions: wire.questions.map((q) => ({
          field: q.field,
          header: q.header ?? undefined,
          text: q.text,
          multiSelect: q.multiSelect,
          customField: q.customField ?? undefined,
          options: q.options.map((o) => ({
            value: o.value,
            label: o.label,
            description: o.description ?? undefined,
          })),
        })),
      };
    case "toolUse":
      return { kind: "tool", name: wire.name, detail: wire.detail };
    case "toolCall":
      return {
        kind: "toolCall",
        toolCallId: wire.id,
        toolKind: wire.kind,
        title: wire.title,
        status: wire.status,
      };
    case "toolCallUpdate":
      return {
        kind: "toolCallUpdate",
        toolCallId: wire.id,
        status: wire.status ?? undefined,
        title: wire.title ?? undefined,
        content: wire.content.map(toDomainToolContent),
        locations: wire.locations.map((l) => ({
          path: l.path,
          line: l.line ?? undefined,
        })),
      };
    case "modeChanged":
      return { kind: "modeChanged", modeId: wire.modeId };
    case "sessionStage":
      return { kind: "sessionStage", stage: wire.stage };
    case "commandsUpdated":
      return { kind: "commands", commands: wire.commands };
    case "errorOccurred":
      return {
        kind: "error",
        message: wire.message,
        context: wire.context ?? undefined,
        stderrTail: wire.stderrTail ?? undefined,
      };
    case "turnCompleted":
      return {
        kind: "completed",
        result: wire.result ?? undefined,
        providerSessionId: wire.providerSessionId ?? undefined,
        isError: wire.isError,
        stopReason: wire.stopReason ?? undefined,
      };
  }
}

function toDomainToolContent(wire: WireToolContent) {
  switch (wire.type) {
    case "text":
      return { type: "text" as const, text: wire.text };
    case "diff":
      return {
        type: "diff" as const,
        path: wire.path,
        oldText: wire.oldText ?? undefined,
        newText: wire.newText,
      };
    case "terminal":
      return { type: "terminal" as const, terminalId: wire.terminalId };
  }
}
