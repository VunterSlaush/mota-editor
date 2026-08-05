import type { AgentMode, PermissionPolicy } from "../entities/agentSettings";
import type { McpServerSpec } from "../entities/mcpServer";
import type { ProviderId } from "../entities/provider";

/**
 * Ports layer — boundary interface the use cases call to run an agent turn.
 * Implemented by an outer-layer adapter (Tauri/CLI today, direct HTTP APIs
 * tomorrow). The core never learns which one it is talking to.
 * Dependency Rule: this file is owned by the core; adapters depend on it.
 */

/** One choice offered by an agent's permission request. */
export interface PermissionOption {
  readonly optionId: string;
  readonly name: string;
  /** UI hint: allow_once | allow_always | reject_once | reject_always. */
  readonly kind: string;
}

/** Events an agent emits while working on one turn. */
export type AgentTurnEvent =
  | { kind: "session"; providerSessionId: string }
  | { kind: "assistant"; text: string }
  | { kind: "assistantDelta"; text: string }
  | { kind: "userDelta"; text: string }
  | { kind: "thoughtDelta"; text: string }
  | {
      kind: "plan";
      entries: readonly { content: string; priority: string; status: string }[];
    }
  | { kind: "usage"; used: number; size: number }
  | { kind: "tool"; name: string; detail: string }
  | { kind: "commands"; commands: readonly { name: string; description: string }[] }
  | {
      kind: "permission";
      requestId: string;
      title: string;
      options: readonly PermissionOption[];
      /** The full plan text when this request is a plan approval. */
      planMarkdown?: string;
      /** Where the agent saved the plan on disk, when it did. */
      planFilePath?: string;
    }
  | { kind: "error"; message: string }
  | {
      kind: "completed";
      result?: string;
      providerSessionId?: string;
      isError: boolean;
    };

export interface AgentTurnRequest {
  readonly tabId: string;
  readonly provider: ProviderId;
  readonly projectPath: string;
  readonly prompt: string;
  readonly mode: AgentMode;
  readonly permission: PermissionPolicy;
  /** Model override; undefined = provider default. */
  readonly model?: string;
  /** Reasoning-effort override; undefined = provider default. */
  readonly effort?: string;
  /** Full paths of files attached to this prompt. */
  readonly attachments: readonly string[];
  /** Provider-side session to resume, when the provider supports it. */
  readonly resumeSessionId?: string;
  /** MCP servers to hand the agent when its session is created. */
  readonly mcpServers?: readonly McpServerSpec[];
}

export interface AgentGateway {
  /** Start one agent turn; events arrive via the given callback. */
  startTurn(
    request: AgentTurnRequest,
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void>;

  /** Cancel the in-flight turn for a tab, if any. */
  cancelTurn(tabId: string): Promise<void>;

  /** Answer a pending permission request with the chosen option. */
  respondPermission(tabId: string, requestId: string, optionId: string): Promise<void>;

  /** Tear down the tab's agent session entirely (tab closed). */
  endSession(tabId: string): Promise<void>;

  /**
   * Pre-start the tab's agent session in the background so the first
   * message doesn't pay the handshake cost. Best-effort: failures are
   * silent (the real turn will surface them properly).
   */
  warmSession(
    tabId: string,
    provider: ProviderId,
    projectPath: string,
    model?: string,
    effort?: string,
    mcpServers?: readonly McpServerSpec[],
  ): Promise<void>;

  /** The agent's OWN saved sessions for this project (native history). */
  listNativeSessions(
    tabId: string,
    provider: ProviderId,
    projectPath: string,
    model?: string,
    effort?: string,
  ): Promise<{ sessionId: string; title?: string; updatedAt?: string }[]>;

  /**
   * Truly resume one of the agent's saved sessions: the conversation is
   * replayed through `onEvent`, and the agent continues WITH that
   * context in memory.
   */
  loadNativeSession(
    request: {
      tabId: string;
      provider: ProviderId;
      projectPath: string;
      model?: string;
      effort?: string;
      sessionId: string;
    },
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<void>;
}
