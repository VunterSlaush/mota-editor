import {
  ArrowDown,
  ArrowUp,
  ClipboardText,
  LockKey,
  Paperclip,
} from "@phosphor-icons/react";
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { permissionOptionHint } from "../../core/entities/approval";
import { formatElapsed } from "../../core/entities/duration";
import type { ChatMessage } from "../../core/entities/message";
import { fileName } from "../fileName";
import { CommandText } from "./CommandText";
import { Markdown } from "./MarkdownLite";
import { QuestionCard } from "./QuestionCard";

interface Props {
  messages: readonly ChatMessage[];
  /** True while a turn runs — drives the streaming caret. */
  busy: boolean;
  /** When the running turn started, for the elapsed counter. */
  turnStartedAt?: number;
  /** Lowercased slash-command names, for highlighting in user messages.
   *  Must be a stable identity — it reaches memoized rows. */
  commands: ReadonlySet<string>;
  /** When false, only the conversation itself shows: user + assistant
   *  messages, approvals, and errors — no tools, thoughts, or status. */
  verbose: boolean;
  onRespondPermission: (requestId: string, optionId: string) => void;
  onAnswerQuestion: (requestId: string, answers: Record<string, string>) => void;
  onShowPlan: () => void;
}

const QUIET_ROLES = new Set(["tool", "thought", "info"]);

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
        {rows.map(({ message: m, count, detail }) =>
          m.role === "question" ? (
            <QuestionCard key={m.id} message={m} onAnswer={onAnswerQuestion} />
          ) : m.role === "approval" ? (
            <ApprovalCard
              key={m.id}
              message={m}
              onRespond={onRespondPermission}
              onShowPlan={onShowPlan}
            />
          ) : (
            <MessageBubble
              key={m.id}
              message={m}
              count={count}
              detail={detail}
              commands={commands}
              streaming={m.id === streamingId}
              innerRef={m.id === askedMessage?.id ? promptRef : undefined}
            />
          ),
        )}
        {busy && <WorkingIndicator startedAt={turnStartedAt} />}
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

/** A transcript row: one message, standing in for `count` grouped ones. */
interface Row {
  readonly message: ChatMessage;
  readonly count: number;
  /** Newline-joined details of every run in the group (tool rows only). */
  readonly detail: string;
}

/**
 * Collapse consecutive runs of the same tool into one row with a count.
 * An agent that searches four times in a row would otherwise print four
 * separate "search" lines; one row saying "search ×4" with the four
 * queries stacked under it reads far better. Grouping is by tool name
 * only — the individual details are kept and listed inside the row
 * (exact duplicate details collapse to one line).
 */
function groupToolRuns(messages: readonly ChatMessage[]): Row[] {
  const rows: Row[] = [];
  for (const message of messages) {
    const prev = rows[rows.length - 1];
    if (
      prev &&
      message.role === "tool" &&
      prev.message.role === "tool" &&
      prev.message.toolName === message.toolName
    ) {
      const lines = prev.detail.split("\n");
      const detail = lines.includes(message.text)
        ? prev.detail
        : `${prev.detail}\n${message.text}`;
      rows[rows.length - 1] = {
        message: prev.message,
        count: prev.count + 1,
        detail,
      };
    } else {
      rows.push({ message, count: 1, detail: message.text });
    }
  }
  return rows;
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
function WorkingIndicator({ startedAt }: { startedAt?: number }) {
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
      Working…
      {startedAt !== undefined && (
        <span className="working__elapsed">{formatElapsed(now - startedAt)}</span>
      )}
    </div>
  );
}

/** The agent asked for permission: title + one button per option.
 *  Memoized (like MessageBubble): while a turn streams, every delta
 *  re-renders the list, and settled rows must not re-render with it. */
const ApprovalCard = memo(function ApprovalCard({
  message,
  onRespond,
  onShowPlan,
}: {
  message: ChatMessage;
  onRespond: (requestId: string, optionId: string) => void;
  onShowPlan: () => void;
}) {
  const approval = message.approval;
  if (!approval) return null;
  const answered = Boolean(approval.resolvedOptionId) || Boolean(approval.cancelled);
  const chosen = approval.options.find((o) => o.optionId === approval.resolvedOptionId);

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

/** Memoized: message objects are referentially stable except the one
 *  still streaming, so each delta re-renders exactly one bubble instead
 *  of re-parsing the whole transcript's markdown. */
const MessageBubble = memo(function MessageBubble({
  message,
  count = 1,
  detail,
  commands,
  streaming,
  innerRef,
}: {
  message: ChatMessage;
  /** How many tool runs this row stands for (see groupToolRuns). */
  count?: number;
  /** Newline-joined details of every run in the group (tool rows only). */
  detail?: string;
  commands: ReadonlySet<string>;
  streaming: boolean;
  /** Set on the message the PinnedPrompt tracks, so it can be measured. */
  innerRef?: React.Ref<HTMLDivElement>;
}) {
  if (message.role === "tool") {
    const lines = (detail ?? message.text).split("\n");
    return (
      <div className="msg msg--tool">
        <span className="msg__tool-name">{message.toolName}</span>
        <span className="msg__tool-details">
          {lines.map((line) => (
            <code key={line} className="msg__tool-detail">
              {line}
            </code>
          ))}
        </span>
        {count > 1 && <span className="msg__tool-count">×{count}</span>}
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
