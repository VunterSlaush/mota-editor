import type { ChatMessage } from "./message";
import { estimateTokens } from "./tokens";

/**
 * Entities layer — the short brief a delegated command carries into its
 * sub-agent.
 *
 * A child starts with no conversation, which is the entire point: it is
 * why its tokens are cheap and why its tool output never lands in the
 * parent transcript. But some intent only ever existed in the chat —
 * "commit this as the fix for the bug we just found" hands a pronoun to
 * an agent with no referent, and it will invent one rather than ask. A
 * few hundred tokens of recent conversation buys that back for about 1%
 * of what the isolation saves.
 */

/** Big enough for the last exchange or two, small enough to stay noise. */
export const HANDOFF_BUDGET_TOKENS = 2000;

/** Only these two carry intent. Tool output is what we are escaping, and
 *  thoughts, notices and approval cards are chatter about the mechanics. */
const CARRIES_INTENT = new Set(["user", "assistant"]);

/**
 * The most recent conversation that fits the budget, oldest first.
 *
 * Newest messages win: the brief exists to resolve "this" and "we just",
 * which always point at the end of the conversation, never the start.
 * Returns "" when there is nothing worth sending, so the caller can omit
 * the section entirely rather than send an empty heading.
 */
export function buildHandoff(
  messages: readonly ChatMessage[],
  budgetTokens: number = HANDOFF_BUDGET_TOKENS,
): string {
  const eligible = messages.filter(
    (m) => CARRIES_INTENT.has(m.role) && m.text.trim() !== "",
  );

  const taken: ChatMessage[] = [];
  for (let i = eligible.length - 1; i >= 0; i--) {
    const candidate = [eligible[i], ...taken];
    if (estimateTokens(candidate) > budgetTokens) break;
    taken.unshift(eligible[i]);
  }
  if (taken.length === 0) return "";

  return taken
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.text.trim()}`)
    .join("\n\n");
}
