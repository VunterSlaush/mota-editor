import type { AgentMode, PermissionPolicy } from "../entities/agentSettings";
import type { McpServerSpec } from "../entities/mcpServer";
import type { Question, ToolCallContent, ToolLocation } from "../entities/message";
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
  | {
      kind: "toolCall";
      toolCallId: string;
      toolKind: string;
      title: string;
      status: string;
    }
  | {
      kind: "toolCallUpdate";
      toolCallId: string;
      status?: string;
      title?: string;
      content?: readonly ToolCallContent[];
      locations?: readonly ToolLocation[];
    }
  | { kind: "modeChanged"; modeId: string }
  | { kind: "sessionStage"; stage: string }
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
      /** The tool call this request guards, when the agent named it. */
      toolCallId?: string;
    }
  | {
      kind: "question";
      requestId: string;
      /** Shown above the questions; for a single question it IS the question. */
      message: string;
      questions: readonly Question[];
    }
  | {
      kind: "error";
      message: string;
      /** Machine-readable tag ("agent-exited", ...). */
      context?: string;
      /** The agent process's last stderr lines, when relevant. */
      stderrTail?: string;
    }
  | {
      kind: "completed";
      result?: string;
      providerSessionId?: string;
      isError: boolean;
      /** ACP stopReason (end_turn|max_tokens|max_turn_requests|refusal|cancelled). */
      stopReason?: string;
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

  /**
   * Receive session-level events (startup stages, agent mode switches)
   * that arrive OUTSIDE a turn — e.g. while a session warms in the
   * background. At most one subscriber; events during a turn keep going
   * to the turn's own callback.
   */
  subscribeSessionEvents(onEvent: (tabId: string, event: AgentTurnEvent) => void): void;

  /** Cancel the in-flight turn for a tab, if any. */
  cancelTurn(tabId: string): Promise<void>;

  /** Answer a pending permission request with the chosen option. */
  respondPermission(tabId: string, requestId: string, optionId: string): Promise<void>;

  /**
   * Answer a pending agent question. Answers are keyed by form field; an
   * empty object means the user skipped.
   */
  respondQuestion(
    tabId: string,
    requestId: string,
    answers: Readonly<Record<string, string>>,
  ): Promise<void>;

  /** Tear down the tab's agent session entirely (tab closed). */
  endSession(tabId: string): Promise<void>;

  /**
   * Captured output of a client-owned terminal (`terminal/create`d by
   * the agent). Null when the terminal (or session) no longer exists.
   * Polled by the UI while the command runs.
   */
  readTerminalOutput(
    tabId: string,
    terminalId: string,
  ): Promise<{ output: string; truncated: boolean; exited: boolean } | null>;

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

  /**
   * The agent's OWN saved sessions for this project (native history),
   * answered only by an ALREADY-live session. Null means "no live
   * session — didn't ask": listing must never boot an agent process,
   * so the History panel can serve itself from the local store.
   */
  listNativeSessions(
    tabId: string,
    provider: ProviderId,
    projectPath: string,
    model?: string,
    effort?: string,
    mcpServers?: readonly McpServerSpec[],
  ): Promise<{ sessionId: string; title?: string; updatedAt?: string }[] | null>;

  /**
   * Truly resume one of the agent's saved sessions: the agent continues
   * WITH that context in memory. `replayed` says whether the
   * conversation streamed through `onEvent` — with `preferResume` the
   * agent may attach without a replay, and the caller paints the
   * conversation from its own transcript copy instead.
   */
  loadNativeSession(
    request: {
      tabId: string;
      provider: ProviderId;
      projectPath: string;
      model?: string;
      effort?: string;
      sessionId: string;
      mcpServers?: readonly McpServerSpec[];
      /** Set only when a local transcript copy exists to paint from. */
      preferResume?: boolean;
    },
    onEvent: (event: AgentTurnEvent) => void,
  ): Promise<{ replayed: boolean }>;
}
