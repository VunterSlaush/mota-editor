import { ArrowClockwise, X } from "@phosphor-icons/react";
import { describePending, type PendingSpec, pendingCostWarning } from "./pendingSpecText";

interface Props {
  pending: PendingSpec;
  /** Context tokens the agent is holding — what a restart re-sends. */
  contextTokens?: number;
  onApplyNow: () => void;
  onDiscard: () => void;
}

/**
 * UI — a model/effort change is queued rather than live.
 *
 * The app used to apply these silently, which quietly retired the agent
 * and made the next turn re-send the whole conversation. This says so
 * before it happens, and leaves the choice with the user: waiting until
 * the next chat costs nothing, applying now costs a re-send.
 *
 * Humble View: no decisions here, just the two use cases. The wording —
 * including which of the two changes definitely costs money — lives in
 * pendingSpecText.ts, where it is tested.
 */
export function PendingSpecBar({ pending, contextTokens, onApplyNow, onDiscard }: Props) {
  return (
    <div className="pending-spec" role="status">
      <span className="pending-spec__text">
        <strong>{describePending(pending)}</strong> on your next chat.{" "}
        {pendingCostWarning(pending, contextTokens)}
      </span>
      <button
        type="button"
        className="pending-spec__action"
        onClick={onApplyNow}
        title="Restart the agent now and re-send the conversation"
      >
        <ArrowClockwise weight="bold" /> Apply now
      </button>
      <button
        type="button"
        className="pending-spec__action pending-spec__action--dim"
        onClick={onDiscard}
        title="Forget this change and keep the current setup"
      >
        <X weight="bold" /> Discard
      </button>
    </div>
  );
}
