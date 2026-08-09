import { ArrowsInLineHorizontal, ChatCircleDots, X } from "@phosphor-icons/react";

interface Props {
  percent: number;
  onCompact: () => void;
  onNewChat: () => void;
  onDismiss: () => void;
}

/**
 * UI — the context window is nearly full, and the user chose to decide
 * what happens rather than have it decided for them.
 *
 * Both options are priced honestly, because the cheaper one is not the
 * obvious one: compacting reads the whole conversation and re-writes the
 * cache on the next turn, while a new chat starts from nothing. What it
 * costs instead is the conversation, which is the actual trade.
 */
export function ContextFullBar({ percent, onCompact, onNewChat, onDismiss }: Props) {
  return (
    <div className="pending-spec" role="status">
      <span className="pending-spec__text">
        <strong>Context {percent}% full.</strong> Compacting summarizes this conversation
        — a full pass over it, then a fresh cache next turn. A new chat costs nothing but
        starts the agent empty.
      </span>
      <button
        type="button"
        className="pending-spec__action"
        onClick={onCompact}
        title="Ask the agent to summarize the conversation so far"
      >
        <ArrowsInLineHorizontal weight="bold" /> Compact
      </button>
      <button
        type="button"
        className="pending-spec__action"
        onClick={onNewChat}
        title="Start a fresh conversation — the agent forgets this one"
      >
        <ChatCircleDots weight="bold" /> New chat
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
