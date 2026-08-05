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

export interface ChatMessage {
  readonly id: string;
  readonly role: MessageRole;
  readonly text: string;
  /** For tool messages: the tool name (e.g. "Bash", "Edit"). */
  readonly toolName?: string;
  /** For user messages: full paths of files attached to this message. */
  readonly attachments?: readonly string[];
  /** For approval messages: the request and its options. */
  readonly approval?: ApprovalState;
  /** For question messages: what the agent asked. */
  readonly question?: QuestionState;
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
): ChatMessage {
  const message: ChatMessage = { id: nextMessageId(), role: "user", text };
  return attachments.length > 0 ? { ...message, attachments } : message;
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

export function errorMessage(text: string): ChatMessage {
  return { id: nextMessageId(), role: "error", text };
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

export function approvalMessage(
  title: string,
  requestId: string,
  options: readonly ApprovalOption[],
  planMarkdown?: string,
): ChatMessage {
  return {
    id: nextMessageId(),
    role: "approval",
    text: title,
    approval: { requestId, options, planMarkdown },
  };
}
