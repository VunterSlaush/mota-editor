import { ArrowClockwise, X } from "@phosphor-icons/react";
import { formatTokens } from "../../core/entities/tokens";

interface Props {
  pending: { readonly model?: string; readonly effort?: string };
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
 * Humble View: no decisions here, just the two use cases.
 */
export function PendingSpecBar({ pending, contextTokens, onApplyNow, onDiscard }: Props) {
  return (
    <div className="pending-spec" role="status">
      <span className="pending-spec__text">
        <strong>{describe(pending)}</strong> on your next chat.{" "}
        {costWarning(pending, contextTokens)}
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

/** "Opus", "high effort", or "Opus and high effort" — as a sentence subject. */
function describe(pending: Props["pending"]): string {
  const parts: string[] = [];
  if (pending.model !== undefined) {
    parts.push(pending.model === "" ? "The default model" : pending.model);
  }
  if (pending.effort !== undefined) {
    parts.push(pending.effort === "" ? "the default effort" : `${pending.effort} effort`);
  }
  const joined = parts.join(" and ");
  return `${joined.charAt(0).toUpperCase()}${joined.slice(1)} applies`;
}

/**
 * What applying now actually costs — worded to match what happens.
 *
 * A MODEL change is the expensive one: the prompt cache is keyed per
 * model, so none of the re-sent context can be read from cache and all
 * of it is billed at write rates. An EFFORT change keeps the same model,
 * so a warm cache may still absorb it — promising a bill either way
 * would be the same dishonesty this bar exists to fix.
 */
function costWarning(pending: Props["pending"], contextTokens?: number): string {
  const size =
    contextTokens !== undefined && contextTokens > 0
      ? ` (~${formatTokens(contextTokens)} tokens)`
      : "";
  return pending.model !== undefined
    ? `Applying now restarts the agent and re-sends this conversation${size} at cache-write rates.`
    : `Applying now restarts the agent, which may re-send this conversation${size}.`;
}
