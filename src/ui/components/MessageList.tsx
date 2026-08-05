import {
  ArrowDown,
  ArrowUp,
  CaretDown,
  CaretUp,
  Check,
  CircleNotch,
  ClipboardText,
  LockKey,
  Paperclip,
  X,
} from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { permissionOptionHint } from "../../core/entities/approval";
import { formatElapsed } from "../../core/entities/duration";
import type { ChatMessage, ToolCallState } from "../../core/entities/message";
import { fileName } from "../fileName";
import { CommandText } from "./CommandText";
import { Markdown } from "./MarkdownLite";
import { QuestionCard } from "./QuestionCard";
import { type AgentDiff, ToolCallContentView } from "./ToolCallContentView";

interface Props {
  messages: readonly ChatMessage[];
  /** True while a turn runs — drives the streaming caret. */
  busy: boolean;
  /** When the running turn started, for the elapsed counter. */
  turnStartedAt?: number;
  /** Session startup stage (installing|booting|creating|recovering). */
  sessionStage?: string;
  /** Re-send the last prompt; offered on the trailing error bubble.
   *  Stable identity — reaches memoized rows. */
  onRetry: () => void;
  /** Open a file the agent touched. Stable identity. */
  onOpenFile: (path: string) => void;
  /** Show an agent-reported diff in the diff modal. Stable identity. */
  onShowAgentDiff: (diff: AgentDiff) => void;
  /** Lowercased slash-command names, for highlighting in user messages.
   *  Must be a stable identity — it reaches memoized rows. */
  commands: ReadonlySet<string>;
  /** When false, only the conversation itself shows: user + assistant
   *  messages, approvals, errors, and info notices — no tools or thoughts. */
  verbose: boolean;
  onRespondPermission: (requestId: string, optionId: string) => void;
  onAnswerQuestion: (requestId: string, answers: Record<string, string>) => void;
  onShowPlan: () => void;
}

// Info stays visible: cancellations, fallback notices, and stop-reason
// warnings are part of the conversation, not diagnostics.
const QUIET_ROLES = new Set(["tool", "thought"]);

/** How close to the bottom (px) still counts as "following the stream". */
const FOLLOW_THRESHOLD = 48;

/**
 * UI — renders the conversation. Follows the stream like Claude Code:
 * pinned to the bottom while new content arrives, but the moment the
 * user scrolls up to read, it stays put until they return to the bottom.
 */
export function MessageList({
  messages,
  busy,
  turnStartedAt,
  sessionStage,
  onRetry,
  onOpenFile,
  onShowAgentDiff,
  commands,
  verbose,
  onRespondPermission,
  onAnswerQuestion,
  onShowPlan,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const [promptScrolledAway, setPromptScrolledAway] = useState(false);
  const visible = verbose ? messages : messages.filter((m) => !QUIET_ROLES.has(m.role));
  const rows = groupToolRuns(visible);
  const last = visible[visible.length - 1];
  const askedMessage = lastUserMessage(visible);
  const contentKey = `${visible.length}:${last?.text.length ?? 0}`;

  /** True once the user's prompt has scrolled off the top of the list. */
  const syncPromptVisibility = useCallback(() => {
    const el = scrollerRef.current;
    const prompt = promptRef.current;
    if (!el || !prompt) {
      setPromptScrolledAway(false);
      return;
    }
    setPromptScrolledAway(
      prompt.getBoundingClientRect().bottom < el.getBoundingClientRect().top,
    );
  }, []);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
    syncPromptVisibility();
  }, [contentKey, following, syncPromptVisibility]);

  // A new turn always re-pins: sending a message means "show me".
  useEffect(() => {
    if (busy) setFollowing(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    const nearBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_THRESHOLD;
    setFollowing(nearBottom);
    syncPromptVisibility();
  };

  const scrollToPrompt = () => {
    promptRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  const streamingId = busy && last?.role === "assistant" ? last.id : null;

  return (
    <div className="message-list-wrap">
      {askedMessage && promptScrolledAway && (
        <PinnedPrompt
          message={askedMessage}
          commands={commands}
          onJump={scrollToPrompt}
        />
      )}
      <div className="message-list" ref={scrollerRef} onScroll={onScroll}>
        {rows.map(({ message: m, count, detail, status }) =>
          m.role === "question" ? (
            <QuestionCard key={m.id} message={m} onAnswer={onAnswerQuestion} />
          ) : m.role === "approval" ? (
            <ApprovalCard
              key={m.id}
              message={m}
              guardedToolCall={findToolCall(messages, m.approval?.toolCallId)}
              onRespond={onRespondPermission}
              onShowPlan={onShowPlan}
              onOpenFile={onOpenFile}
              onShowAgentDiff={onShowAgentDiff}
            />
          ) : (
            <MessageBubble
              key={m.id}
              message={m}
              count={count}
              detail={detail}
              status={status}
              commands={commands}
              streaming={m.id === streamingId}
              onRetry={
                !busy && m.role === "error" && m.id === last?.id ? onRetry : undefined
              }
              onOpenFile={onOpenFile}
              onShowAgentDiff={onShowAgentDiff}
              innerRef={m.id === askedMessage?.id ? promptRef : undefined}
            />
          ),
        )}
        {busy && <WorkingIndicator startedAt={turnStartedAt} stage={sessionStage} />}
        {!busy && sessionStage && (
          <div className="session-stage" aria-live="polite">
            <span className="working__dot" /> {stageLabel(sessionStage)}
          </div>
        )}
      </div>
      {!following && (
        <button
          type="button"
          className="jump-to-latest"
          onClick={() => setFollowing(true)}
          aria-label="Jump to latest"
        >
          <ArrowDown size={13} /> Latest
        </button>
      )}
    </div>
  );
}

/** Aggregate lifecycle of a (possibly grouped) tool row. */
type RowStatus = "running" | "completed" | "failed";

/** A transcript row: one message, standing in for `count` grouped ones. */
interface Row {
  readonly message: ChatMessage;
  readonly count: number;
  /** Newline-joined details of every run in the group (tool rows only). */
  readonly detail: string;
  /** Worst status across the group; undefined for legacy tool rows. */
  readonly status?: RowStatus;
}

/** One tool call's contribution to its row's aggregate status. */
function statusOf(message: ChatMessage): RowStatus | undefined {
  const status = message.toolCall?.status;
  if (!status) return undefined;
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "running"; // pending, in_progress, and unknown strings
}

/** Failed beats running beats completed: the group shows its worst news. */
function mergeStatus(a?: RowStatus, b?: RowStatus): RowStatus | undefined {
  if (a === "failed" || b === "failed") return "failed";
  if (a === "running" || b === "running") return "running";
  return a ?? b;
}

/**
 * Collapse consecutive runs of the same tool into one row with a count.
 * An agent that searches four times in a row would otherwise print four
 * separate "search" lines; one row saying "search ×4" with the four
 * queries stacked under it reads far better. Grouping is by tool name
 * only — the individual details are kept and listed inside the row
 * (exact duplicate details collapse to one line).
 */
/** A tool row with reported output/locations is worth its own row —
 *  collapsing it into a group would hide what it brought back. */
function hasSubstance(message: ChatMessage): boolean {
  const call = message.toolCall;
  return Boolean(call && (call.content.length > 0 || call.locations.length > 0));
}

function groupToolRuns(messages: readonly ChatMessage[]): Row[] {
  const rows: Row[] = [];
  for (const message of messages) {
    const prev = rows[rows.length - 1];
    if (
      prev &&
      message.role === "tool" &&
      prev.message.role === "tool" &&
      prev.message.toolName === message.toolName &&
      !hasSubstance(message) &&
      !hasSubstance(prev.message)
    ) {
      const lines = prev.detail.split("\n");
      const detail = lines.includes(message.text)
        ? prev.detail
        : `${prev.detail}\n${message.text}`;
      rows[rows.length - 1] = {
        message: prev.message,
        count: prev.count + 1,
        detail,
        status: mergeStatus(prev.status, statusOf(message)),
      };
    } else {
      rows.push({ message, count: 1, detail: message.text, status: statusOf(message) });
    }
  }
  return rows;
}

/** The tool call an approval guards, by the id the agent attached. The
 *  message object is referentially stable, so the memoized card only
 *  re-renders when the call itself is updated. */
function findToolCall(
  messages: readonly ChatMessage[],
  toolCallId: string | undefined,
): ToolCallState | undefined {
  if (!toolCallId) return undefined;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const call = messages[i].toolCall;
    if (call?.toolCallId === toolCallId) return call;
  }
  return undefined;
}

/** The most recent thing the user asked, whatever the agent has said since. */
function lastUserMessage(messages: readonly ChatMessage[]): ChatMessage | undefined {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (messages[i].role === "user") return messages[i];
  }
  return undefined;
}

/**
 * UI — the user's prompt, held at the top of the transcript once it has
 * scrolled away, so a long answer never leaves them wondering what they
 * asked. Click it to jump back to the message itself.
 */
function PinnedPrompt({
  message,
  commands,
  onJump,
}: {
  message: ChatMessage;
  commands: ReadonlySet<string>;
  onJump: () => void;
}) {
  return (
    <button
      type="button"
      className="pinned-prompt"
      title={message.text}
      aria-label="Jump to your message"
      onClick={onJump}
    >
      <span className="pinned-prompt__label">You asked</span>
      <span className="pinned-prompt__text">
        <CommandText text={message.text} commands={commands} />
      </span>
      <ArrowUp size={13} className="pinned-prompt__jump" />
    </button>
  );
}

/**
 * Claude-Code-style shimmer and elapsed clock, shown for the whole turn
 * — including while the reply streams — and gone the moment the agent
 * stops. A long silence should read as "still working", not "stuck".
 * The start time comes from the tab, not from this component's mount, so
 * switching away and back doesn't restart the count.
 */
function WorkingIndicator({ startedAt, stage }: { startedAt?: number; stage?: string }) {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (startedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return (
    <div className="working" aria-live="polite">
      <span className="working__dot" />
      {stage ? stageLabel(stage) : "Working…"}
      {startedAt !== undefined && (
        <span className="working__elapsed">{formatElapsed(now - startedAt)}</span>
      )}
    </div>
  );
}

/** Human words for a session startup stage. */
function stageLabel(stage: string): string {
  switch (stage) {
    case "installing":
      return "Installing the agent adapter (first run)…";
    case "booting":
      return "Starting the agent…";
    case "creating":
      return "Creating the session…";
    case "recovering":
      return "Recovering the previous session…";
    default:
      return `${stage}…`;
  }
}

/** The agent asked for permission: title + one button per option.
 *  Memoized (like MessageBubble): while a turn streams, every delta
 *  re-renders the list, and settled rows must not re-render with it. */
const ApprovalCard = memo(function ApprovalCard({
  message,
  guardedToolCall,
  onRespond,
  onShowPlan,
  onOpenFile,
  onShowAgentDiff,
}: {
  message: ChatMessage;
  /** The tool call this request guards, when the agent named it — shown
   *  so the user approves what will actually run, not just a title. */
  guardedToolCall?: ToolCallState;
  onRespond: (requestId: string, optionId: string) => void;
  onShowPlan: () => void;
  onOpenFile: (path: string) => void;
  onShowAgentDiff: (diff: AgentDiff) => void;
}) {
  const approval = message.approval;
  if (!approval) return null;
  const answered = Boolean(approval.resolvedOptionId) || Boolean(approval.cancelled);
  const chosen = approval.options.find((o) => o.optionId === approval.resolvedOptionId);
  const preview =
    guardedToolCall &&
    (guardedToolCall.content.length > 0 || guardedToolCall.locations.length > 0);

  return (
    <div className="approval">
      <div className="approval__title">
        <LockKey /> {message.text}
      </div>
      {approval.planMarkdown && (
        <button type="button" className="approval__plan-link" onClick={onShowPlan}>
          <ClipboardText /> View the plan
        </button>
      )}
      {/* Force-shown while unanswered: what is being approved must be
          visible at the moment of the decision. */}
      {preview && !answered && guardedToolCall && (
        <ToolCallContentView
          toolCall={guardedToolCall}
          onOpenFile={onOpenFile}
          onShowDiff={onShowAgentDiff}
        />
      )}
      <div className="approval__options">
        {approval.options.map((option) => {
          const hint = permissionOptionHint(option.optionId);
          return (
            <button
              type="button"
              key={option.optionId}
              className={`approval__button ${
                option.kind.startsWith("reject") ? "approval__button--reject" : ""
              }`}
              disabled={answered}
              onClick={() => onRespond(approval.requestId, option.optionId)}
            >
              <span className="approval__button-label">{option.name}</span>
              {hint && <span className="approval__button-hint">{hint}</span>}
            </button>
          );
        })}
      </div>
      {chosen && <div className="approval__status">You chose: {chosen.name}</div>}
      {approval.cancelled && !chosen && (
        <div className="approval__status">The turn ended before you answered.</div>
      )}
    </div>
  );
});

/** Spinner while a tool runs; check or cross once it settled. */
function ToolStatusIcon({ status }: { status: "running" | "completed" | "failed" }) {
  if (status === "running") {
    return <CircleNotch size={12} className="msg__tool-status msg__tool-status--spin" />;
  }
  if (status === "failed") {
    return (
      <X size={12} weight="bold" className="msg__tool-status msg__tool-status--failed" />
    );
  }
  return (
    <Check size={12} weight="bold" className="msg__tool-status msg__tool-status--done" />
  );
}

/** Memoized: message objects are referentially stable except the one
 *  still streaming, so each delta re-renders exactly one bubble instead
 *  of re-parsing the whole transcript's markdown. */
const MessageBubble = memo(function MessageBubble({
  message,
  count = 1,
  detail,
  status,
  commands,
  streaming,
  onRetry,
  onOpenFile,
  onShowAgentDiff,
  innerRef,
}: {
  message: ChatMessage;
  /** How many tool runs this row stands for (see groupToolRuns). */
  count?: number;
  /** Newline-joined details of every run in the group (tool rows only). */
  detail?: string;
  /** Aggregate tool-call status; undefined for legacy rows (no icon). */
  status?: "running" | "completed" | "failed";
  commands: ReadonlySet<string>;
  streaming: boolean;
  /** Set only on the trailing error bubble while idle: offer a retry. */
  onRetry?: () => void;
  /** Open a file the agent touched (tool rows). */
  onOpenFile?: (path: string) => void;
  /** Show an agent-reported diff (tool rows). */
  onShowAgentDiff?: (diff: AgentDiff) => void;
  /** Set on the message the PinnedPrompt tracks, so it can be measured. */
  innerRef?: React.Ref<HTMLDivElement>;
}) {
  // Expansion is per-row UI state, not message state: collapsing again
  // must not touch the transcript.
  const [expanded, setExpanded] = useState(false);
  if (message.role === "tool") {
    const lines = (detail ?? message.text).split("\n");
    const call = message.toolCall;
    const expandable = Boolean(
      call && (call.content.length > 0 || call.locations.length > 0),
    );
    return (
      <div className={`msg msg--tool ${status ? `msg--tool-${status}` : ""}`}>
        <div className="msg__tool-row">
          {status && <ToolStatusIcon status={status} />}
          <span className="msg__tool-name">{message.toolName}</span>
          <span className="msg__tool-details">
            {lines.map((line) => (
              <code key={line} className="msg__tool-detail">
                {line}
              </code>
            ))}
          </span>
          {count > 1 && <span className="msg__tool-count">×{count}</span>}
          {expandable && (
            <button
              type="button"
              className="msg__tool-expand"
              aria-expanded={expanded}
              aria-label={expanded ? "Hide tool output" : "Show tool output"}
              onClick={() => setExpanded((open) => !open)}
            >
              {expanded ? <CaretUp size={12} /> : <CaretDown size={12} />}
            </button>
          )}
        </div>
        {expandable && expanded && call && onOpenFile && onShowAgentDiff && (
          <ToolCallContentView
            toolCall={call}
            onOpenFile={onOpenFile}
            onShowDiff={onShowAgentDiff}
          />
        )}
      </div>
    );
  }
  if (message.role === "assistant") {
    return (
      <div className={`msg msg--assistant ${streaming ? "msg--streaming" : ""}`}>
        <Markdown text={message.text} />
        {streaming && <span className="stream-caret" aria-hidden="true" />}
      </div>
    );
  }
  if (message.role === "error") {
    return (
      <div className="msg msg--error">
        {message.error?.context && (
          <div className="msg__error-context">{message.error.context}</div>
        )}
        <div className="msg__text">{message.text}</div>
        {message.error?.stderrTail && (
          <details className="msg__error-stderr">
            <summary>Agent output</summary>
            <pre>{message.error.stderrTail}</pre>
          </details>
        )}
        {onRetry && (
          <button type="button" className="msg__retry" onClick={onRetry}>
            Retry
          </button>
        )}
      </div>
    );
  }
  return (
    <div className={`msg msg--${message.role}`} ref={innerRef}>
      <div className="msg__text">
        <CommandText text={message.text} commands={commands} />
      </div>
      {message.attachments && message.attachments.length > 0 && (
        <div className="msg__attachments">
          {message.attachments.map((path) => (
            <span key={path} className="msg__attachment" title={path}>
              <Paperclip size={12} /> {fileName(path)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
});
