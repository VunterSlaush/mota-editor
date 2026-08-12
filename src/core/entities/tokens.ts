import type { ChatMessage } from "./message";

/**
 * Entities layer — rough token accounting for when the agent reports
 * none. ~4 characters per token is the industry rule of thumb; the
 * estimate only has to be good enough to keep the context gauge alive
 * and give auto-compact a signal, and it is always displaced by a real
 * `usage_update`.
 */
const CHARS_PER_TOKEN = 4;

/** Fixed cost per message for role/framing overhead. */
const PER_MESSAGE_OVERHEAD = 4;

/** Token counts for display: "742", "12k", "1M", "1.5M". */
export function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${millions % 1 === 0 ? millions : millions.toFixed(1)}M`;
  }
  return tokens >= 1000 ? `${Math.round(tokens / 1000)}k` : String(tokens);
}

export function estimateTokens(messages: readonly ChatMessage[]): number {
  let characters = 0;
  for (const message of messages) {
    characters += message.text.length;
    for (const item of message.toolCall?.content ?? []) {
      if (item.type === "text") characters += item.text.length;
      else if (item.type === "diff") characters += item.newText.length;
    }
  }
  return (
    Math.round(characters / CHARS_PER_TOKEN) + messages.length * PER_MESSAGE_OVERHEAD
  );
}
