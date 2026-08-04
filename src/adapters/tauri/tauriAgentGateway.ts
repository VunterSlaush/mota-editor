import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
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
    | { type: "errorOccurred"; message: string }
    | {
        type: "turnCompleted";
        result: string | null;
        providerSessionId: string | null;
        isError: boolean;
      };
}

export class TauriAgentGateway implements AgentGateway {
  async startTurn(
    request: AgentTurnRequest,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {
    let unlisten: UnlistenFn | null = null;
    const stopListening = () => {
      unlisten?.();
      unlisten = null;
    };

    unlisten = await listen<WireEvent>("agent-event", ({ payload }) => {
      if (payload.tabId !== request.tabId) return;
      const event = toDomainEvent(payload.event);
      onEvent(event);
      if (event.kind === "completed") stopListening();
    });

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
        },
      });
    } catch (e) {
      stopListening();
      throw e instanceof Error ? e : new Error(String(e));
    }
  }

  async cancelTurn(tabId: string): Promise<void> {
    await invoke("cancel_turn", { tabId });
  }

  async respondPermission(
    tabId: string,
    requestId: string,
    optionId: string,
  ): Promise<void> {
    await invoke("respond_permission", { tabId, requestId, optionId });
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
  ): Promise<void> {
    await invoke("warm_session", {
      args: {
        tabId,
        providerId: provider,
        projectPath,
        model: model ?? null,
        effort: effort ?? null,
      },
    });
  }

  async listNativeSessions(
    tabId: string,
    provider: string,
    projectPath: string,
    model?: string,
    effort?: string,
  ): Promise<{ sessionId: string; title?: string; updatedAt?: string }[]> {
    return invoke("list_agent_sessions", {
      args: {
        tabId,
        providerId: provider,
        projectPath,
        model: model ?? null,
        effort: effort ?? null,
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
    },
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void> {
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
        },
      });
    } finally {
      unlisten();
    }
  }
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
