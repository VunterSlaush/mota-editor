import { ArrowsInLineHorizontal, ChatCircleDots, X } from "@phosphor-icons/react";
import { formatTokens } from "../../core/entities/tokens";

interface Props {
  percent: number;
  /** Context the agent is holding — what every further message re-sends. */
  contextTokens?: number;
  onCompact: () => void;
  onNewChat: () => void;
  onDismiss: () => void;
}

/**
 * UI — the context window is nearly full, and the user chose to decide
 * what happens rather than have it decided for them.
 *
 * A new chat leads, because measured on real logs it is the only option
 * that changes the bill much: every turn re-sends the whole conversation,
 * so length compounds and a late turn costs several times an early one.
 * Compaction reads the entire context to shrink it, and saves about what
 * it spends.
 *
 * The trade offered is tokens against MEMORY, not tokens against tokens.
 * A new chat is cheap precisely because the agent forgets, and that is a
 * real cost — so it is stated plainly rather than buried.
 */
export function ContextFullBar({
  percent,
  contextTokens,
  onCompact,
  onNewChat,
  onDismiss,
}: Props) {
  const carrying =
    contextTokens !== undefined && contextTokens > 0
      ? ` Every further message re-sends ~${formatTokens(contextTokens)} tokens.`
      : "";
  return (
    <div className="pending-spec" role="status">
      <span className="pending-spec__text">
        <strong>Context {percent}% full.</strong>
        {carrying} A new chat re-sends nothing, but the agent forgets this one — it stays
        in History. Compacting keeps the thread and costs a full pass over it.
      </span>
      <button
        type="button"
        className="pending-spec__action"
        onClick={onNewChat}
        title="Start a fresh conversation — cheapest, but the agent forgets this one"
      >
        <ChatCircleDots weight="bold" /> New chat
      </button>
      <button
        type="button"
        className="pending-spec__action pending-spec__action--dim"
        onClick={onCompact}
        title="Ask the agent to summarize the conversation so far and keep going"
      >
        <ArrowsInLineHorizontal weight="bold" /> Compact
      </button>
      <button
        type="button"
        className="pending-spec__action pending-spec__action--dim"
        onClick={onDismiss}
        title="Keep going as is"
      >
        <X weight="bold" /> Not now
      </button>
    </div>
  );
}
