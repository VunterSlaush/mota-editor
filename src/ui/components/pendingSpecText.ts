import { formatTokens } from "../../core/entities/tokens";

/** A model/effort change queued for the next chat. `""` = provider default. */
export interface PendingSpec {
  readonly model?: string;
  readonly effort?: string;
}

/**
 * The sentences PendingSpecBar shows. Extracted from the component so the
 * claims they make about money can be tested: the component itself is a
 * humble view and decides nothing.
 */

/** "Opus applies", "high effort applies", "Opus and high effort applies". */
export function describePending(pending: PendingSpec): string {
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
 * model, so none of the re-sent context can be read from cache and all of
 * it is billed at write rates. An EFFORT change keeps the same model, so
 * a warm cache may still absorb it — promising a bill either way would be
 * the same dishonesty this bar exists to fix.
 */
export function pendingCostWarning(
  pending: PendingSpec,
  contextTokens: number | undefined,
): string {
  const size =
    contextTokens !== undefined && contextTokens > 0
      ? ` (~${formatTokens(contextTokens)} tokens)`
      : "";
  return pending.model !== undefined
    ? `Applying now restarts the agent and re-sends this conversation${size} at cache-write rates.`
    : `Applying now restarts the agent, which may re-send this conversation${size}.`;
}
