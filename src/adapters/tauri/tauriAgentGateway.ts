import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { McpServerSpec } from "../../core/entities/mcpServer";
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
    | { type: "commandsUpdated"; commands: { name: string; description: string }[] }
    | {
        type: "permissionRequested";
        requestId: string;
        title: string;
        options: { optionId: string; name: string; kind: string }[];
        planMarkdown: string | null;
        planFilePath: string | null;
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
    | { type: "errorOccurred"; message: string }
    | {
        type: "turnCompleted";
        result: string | null;
        providerSessionId: string | null;
        isError: boolean;
      };
}

export class TauriAgentGateway implements AgentGateway {
  /**
   * One process-wide listener routes events to the active handler per
   * tab. Registering a listener per turn leaked them (a cancelled turn
   * never saw the `completed` that tore its listener down) and a leaked
   * one folded every later event twice.
   */
  private readonly handlers = new Map<string, (event: AgentTurnEvent) => void>();
  private listening: Promise<UnlistenFn> | null = null;

  private async ensureListener(): Promise<void> {
    this.listening ??= listen<WireEvent>("agent-event", ({ payload }) => {
      const handler = this.handlers.get(payload.tabId);
      if (!handler) return;
      const event = toDomainEvent(payload.event);
      handler(event);
      if (event.kind === "completed") this.handlers.delete(payload.tabId);
    });
    await this.listening;
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
        },
      });
    } catch (e) {
      this.handlers.delete(request.tabId);
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  async cancelTurn(tabId: string): Promise<void> {
    // Stopping means "stop": whatever the turn still emits while dying
    // (deltas, tool use, its eventual `completed`) must not fold into
    // the chat after the "Turn cancelled." notice.
    this.handlers.delete(tabId);
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

  async warmSession(
    tabId: string,
    provider: string,
    projectPath: string,
    model?: string,
    effort?: string,
    mcpServers?: readonly McpServerSpec[],
  ): Promise<void> {
    await invoke("warm_session", {
      args: {
        tabId,
        providerId: provider,
        projectPath,
        model: model ?? null,
        effort: effort ?? null,
        mcpServers: toWireServers(mcpServers),
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
  ): Promise<{ sessionId: string; title?: string; updatedAt?: string }[]> {
    return invoke("list_agent_sessions", {
      args: {
        tabId,
        providerId: provider,
        projectPath,
        model: model ?? null,
        effort: effort ?? null,
        mcpServers: toWireServers(mcpServers),
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
    },
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {
    // A stale per-tab handler (e.g. left by a cancelled headless turn)
    // must not also fold the replay into the live chat.
    this.handlers.delete(request.tabId);
    const unlisten = await listen<WireEvent>("agent-event", ({ payload }) => {
      if (payload.tabId !== request.tabId) return;
      onEvent(toDomainEvent(payload.event));
    });
    try {
      // The replay streams through the listener before this resolves.
      await invoke("load_agent_session", {
        args: {
          tabId: request.tabId,
          providerId: request.provider,
          projectPath: request.projectPath,
          model: request.model ?? null,
          effort: request.effort ?? null,
          sessionId: request.sessionId,
          mcpServers: toWireServers(request.mcpServers),
        },
      });
    } finally {
      unlisten();
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
    case "commandsUpdated":
      return { kind: "commands", commands: wire.commands };
    case "errorOccurred":
      return { kind: "error", message: wire.message };
    case "turnCompleted":
      return {
        kind: "completed",
        result: wire.result ?? undefined,
        providerSessionId: wire.providerSessionId ?? undefined,
        isError: wire.isError,
      };
  }
}
