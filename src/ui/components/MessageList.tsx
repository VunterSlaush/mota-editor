import { ArrowDown, ClipboardText, LockKey, Paperclip } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ChatMessage } from "../../core/entities/message";
import { fileName } from "../fileName";
import { Markdown } from "./MarkdownLite";

interface Props {
  messages: readonly ChatMessage[];
  /** True while a turn runs — drives the streaming caret. */
  busy: boolean;
  /** When false, only the conversation itself shows: user + assistant
   *  messages, approvals, and errors — no tools, thoughts, or status. */
  verbose: boolean;
  onRespondPermission: (requestId: string, optionId: string) => void;
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
  verbose,
  onRespondPermission,
  onShowPlan,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [following, setFollowing] = useState(true);
  const visible = verbose ? messages : messages.filter((m) => !QUIET_ROLES.has(m.role));
  const last = visible[visible.length - 1];
  const contentKey = `${visible.length}:${last?.text.length ?? 0}`;

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (el && following) el.scrollTop = el.scrollHeight;
  }, [contentKey, following]);

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
  };

  const streamingId = busy && last?.role === "assistant" ? last.id : null;

  return (
    <div className="message-list-wrap">
      <div className="message-list" ref={scrollerRef} onScroll={onScroll}>
        {visible.map((m) =>
          m.role === "approval" ? (
            <ApprovalCard
              key={m.id}
              message={m}
              onRespond={onRespondPermission}
              onShowPlan={onShowPlan}
            />
          ) : (
            <MessageBubble key={m.id} message={m} streaming={m.id === streamingId} />
          ),
        )}
        {busy && last?.role !== "assistant" && <WorkingIndicator />}
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

/** Claude-Code-style "thinking" shimmer before the reply starts. */
function WorkingIndicator() {
  return (
    <div className="working" aria-live="polite">
      <span className="working__dot" />
      Working…
    </div>
  );
}

/** The agent asked for permission: title + one button per option. */
function ApprovalCard({
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
        {approval.options.map((option) => (
          <button
            type="button"
            key={option.optionId}
            className={`approval__button ${
              option.kind.startsWith("reject") ? "approval__button--reject" : ""
            }`}
            disabled={answered}
            onClick={() => onRespond(approval.requestId, option.optionId)}
          >
            {option.name}
          </button>
        ))}
      </div>
      {chosen && <div className="approval__status">You chose: {chosen.name}</div>}
      {approval.cancelled && !chosen && (
        <div className="approval__status">The turn ended before you answered.</div>
      )}
    </div>
  );
}

function MessageBubble({
  message,
  streaming,
}: {
  message: ChatMessage;
  streaming: boolean;
}) {
  if (message.role === "tool") {
    return (
      <div className="msg msg--tool">
        <span className="msg__tool-name">{message.toolName}</span>
        <code className="msg__tool-detail">{message.text}</code>
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
    <div className={`msg msg--${message.role}`}>
      <div className="msg__text">{message.text}</div>
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
}
