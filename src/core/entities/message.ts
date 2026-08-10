/**
 * Entities layer — a single message in a project conversation.
 */
export type MessageRole =
  | "user"
  | "assistant"
  | "thought"
  | "tool"
  | "error"
  | "info"
  | "approval"
  | "question";

/** An option the user can choose on an approval message. */
export interface ApprovalOption {
  readonly optionId: string;
  readonly name: string;
  readonly kind: string;
}

/** Pending or answered permission request rendered in the chat. */
export interface ApprovalState {
  readonly requestId: string;
  readonly options: readonly ApprovalOption[];
  /** The full plan text when this request is a plan approval. */
  readonly planMarkdown?: string;
  /** The tool call this request guards, when the agent named it. */
  readonly toolCallId?: string;
  /**
   * True when the agent is presenting its plan rather than asking about
   * one tool call. A plan is a stopping point: the turn parks on it, and
   * declining ends the turn instead of letting the agent carry on.
   */
  readonly isPlan?: boolean;
  /** Set once the user picked an option. */
  readonly resolvedOptionId?: string;
  /** True when the turn ended before the user answered. */
  readonly cancelled?: boolean;
}

/** One answer the user can pick for an agent question. */
export interface QuestionOption {
  /** Sent back verbatim; the label is only what we show. */
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

/** One question in an agent's question card. */
export interface Question {
  /** Form field this answer belongs to, echoed back to the agent. */
  readonly field: string;
  readonly header?: string;
  readonly text: string;
  readonly options: readonly QuestionOption[];
  readonly multiSelect: boolean;
  /** Field for a typed answer, when the agent offered an "Other" box. */
  readonly customField?: string;
}

/**
 * The agent asking the user something it cannot decide alone. Distinct
 * from an approval: nothing is being consented to, so there is no
 * allow/deny and no bypass — it always reaches the user.
 */
export interface QuestionState {
  readonly requestId: string;
  readonly questions: readonly Question[];
  /** Answers by field, set once the user submitted. */
  readonly answers?: Readonly<Record<string, string>>;
  /** True when the user chose to skip rather than answer. */
  readonly skipped?: boolean;
  /** True when the turn ended before the user answered. */
  readonly cancelled?: boolean;
}

/** Lifecycle of an ACP tool call (unknown strings render as running). */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

/** One piece of a tool call's reported output. */
export type ToolCallContent =
  | { readonly type: "text"; readonly text: string }
  | {
      readonly type: "diff";
      readonly path: string;
      /** Absent for a newly created file. */
      readonly oldText?: string;
      readonly newText: string;
    }
  | { readonly type: "terminal"; readonly terminalId: string };

/** A file (and optionally line) a tool call touched. */
export interface ToolLocation {
  readonly path: string;
  readonly line?: number;
}

/**
 * Live state of one ACP tool call, updated in place on its chat message
 * as `tool_call_update`s arrive. Legacy tool rows (headless fallback,
 * old transcripts) simply have no `toolCall` and render as before.
 */
export interface ToolCallState {
  readonly toolCallId: string;
  /** ACP category: read | edit | execute | search | think | fetch | ... */
  readonly toolKind: string;
  readonly status: string;
  readonly content: readonly ToolCallContent[];
  readonly locations: readonly ToolLocation[];
}

/**
 * Tag on the one failure the user can always fix themselves. The
 * transcript turns it into a Sign in button, so the remedy is a click
 * rather than a trip to Settings or a terminal.
 */
export const AUTH_REQUIRED_CONTEXT = "auth-required";

/** Extra context carried by an error message. */
export interface ErrorInfo {
  /** Machine-readable tag ("agent-exited", "session-not-restored", ...). */
  readonly context?: string;
  /** The agent process's last stderr lines, when relevant. */
  readonly stderrTail?: string;
}

/**
 * Per-prompt turn details, on user messages only. Send-time fields are
 * set when the prompt goes out; durationMs/tokens/stopReason are patched
 * once when the turn completes. Absent on rows rebuilt from native agent
 * history — such rows render no details affordance.
 */
export interface TurnMeta {
  /** Epoch ms the prompt was sent. */
  readonly sentAt: number;
  /** Plain strings, not the settings types: message.ts imports nothing
   *  and the UI only displays these values. */
  readonly mode: string;
  readonly permission: string;
  /** Undefined = provider default (the agent never reports the model it
   *  actually resolved to). */
  readonly model?: string;
  readonly effort?: string;
  /** Leading slash command, when the prompt was one (e.g. "/review"). */
  readonly command?: string;
  // — patched at completion; durationMs presence gates the details icon —
  /** Turn wall time in ms. */
  readonly durationMs?: number;
  /** Context tokens this turn consumed (usage delta); absent when
   *  unknown, or negative because compaction shrank the context. */
  readonly tokens?: number;
  /** True when either endpoint of the delta was a client-side estimate. */
  readonly tokensEstimated?: boolean;
  /** ACP stop reason, recorded only when not a plain "end_turn". */
  readonly stopReason?: string;
}

export interface ChatMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly text: string;
  /** For tool messages: the tool name (e.g. "Bash", "Edit"). */
  readonly toolName?: string;
  /** For ACP tool messages: identity, status, and reported output. */
  readonly toolCall?: ToolCallState;
  /** For error messages: where the failure came from. */
  readonly error?: ErrorInfo;
  /** For user messages: full paths of files attached to this message. */
  readonly attachments?: readonly string[];
  /** For approval messages: the request and its options. */
  readonly approval?: ApprovalState;
  /** For question messages: what the agent asked. */
  readonly question?: QuestionState;
  /** For user messages: the turn's settings and outcome. */
  readonly turn?: TurnMeta;
}

let counter = 0;

/** Deterministic-enough id for UI keys; not a persistence identity. */
export function nextMessageId(): string {
  counter += 1;
  return `m${counter}`;
}

export function userMessage(
  text: string,
  attachments: readonly string[] = [],
  turn?: TurnMeta,
): ChatMessage {
  return {
    id: nextMessageId(),
    role: "user",
    text,
    ...(attachments.length > 0 ? { attachments } : {}),
    ...(turn ? { turn } : {}),
  };
}

export function assistantMessage(text: string): ChatMessage {
  return { id: nextMessageId(), role: "assistant", text };
}

export function thoughtMessage(text: string): ChatMessage {
  return { id: nextMessageId(), role: "thought", text };
}

export function toolMessage(toolName: string, detail: string): ChatMessage {
  return { id: nextMessageId(), role: "tool", toolName, text: detail };
}

export function toolCallMessage(
  toolCallId: string,
  toolKind: string,
  title: string,
  status: string,
): ChatMessage {
  return {
    id: nextMessageId(),
    role: "tool",
    toolName: toolKind,
    text: title,
    toolCall: { toolCallId, toolKind, status, content: [], locations: [] },
  };
}

/**
 * Fold a `tool_call_update` into a tool call's state. Fields the agent
 * did not send stay as they were; `content`/`locations` replace the
 * previous value when present (ACP sends them cumulatively).
 */
export function mergeToolCall(
  existing: ToolCallState,
  patch: {
    readonly status?: string;
    readonly content?: readonly ToolCallContent[];
    readonly locations?: readonly ToolLocation[];
  },
): ToolCallState {
  return {
    ...existing,
    status: patch.status ?? existing.status,
    content: patch.content && patch.content.length > 0 ? patch.content : existing.content,
    locations:
      patch.locations && patch.locations.length > 0
        ? patch.locations
        : existing.locations,
  };
}

export function errorMessage(text: string, error?: ErrorInfo): ChatMessage {
  const message: ChatMessage = { id: nextMessageId(), role: "error", text };
  return error && (error.context || error.stderrTail) ? { ...message, error } : message;
}

export function infoMessage(text: string): ChatMessage {
  return { id: nextMessageId(), role: "info", text };
}

export function questionMessage(
  message: string,
  requestId: string,
  questions: readonly Question[],
): ChatMessage {
  return {
    id: nextMessageId(),
    role: "question",
    text: message,
    question: { requestId, questions },
  };
}

export function approvalMessage(title: string, approval: ApprovalState): ChatMessage {
  return { id: nextMessageId(), role: "approval", text: title, approval };
}
