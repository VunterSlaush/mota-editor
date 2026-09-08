import type { AutoCompactPolicy } from "./agentSettings";
import type { ChatMessage } from "./message";
import { COMPACT_COMMAND, type ProviderId } from "./provider";

/**
 * Entities layer — what to do about a conversation that has filled its
 * context window.
 *
 * A pure decision, separate from carrying it out, because two of the
 * outcomes start a turn of their own. `SendPrompt` drains its prompt
 * queue the moment a turn completes, and `execute` suspends at its first
 * await long before the tab goes busy — so a caller that could not ask
 * "did this claim the turn?" before draining would start a second,
 * concurrent turn and let the two cancel each other at random.
 */
export type AutoCompactDecision =
  /** Under the ceiling, switched off, or already compacting. */
  | { readonly action: "nothing" }
  /** Back under the ceiling with the question still on screen. */
  | { readonly action: "dismiss" }
  /** Offer both options, with what each costs, and spend nothing. */
  | { readonly action: "ask"; readonly percent: number }
  /** Start a fresh chat; the old one stays in History. */
  | { readonly action: "newChat"; readonly percent: number }
  /** Send the provider's compaction command as a turn. */
  | {
      readonly action: "compact";
      readonly percent: number;
      readonly command: string;
    };

/** The tab as this decision reads it. */
interface CompactableTab {
  readonly messages: readonly ChatMessage[];
  readonly usage?: { readonly used: number; readonly size: number };
  /** The percentage the "ask" card is showing, when one is up. */
  readonly contextFullPercent?: number;
  readonly project: { readonly provider: ProviderId };
}

/**
 * Act on a nearly-full context window, per the user's policy.
 *
 * Compacting is not the win it looks like: measured on real logs it
 * costs about what it saves. What actually drives the bill is
 * conversation LENGTH — every turn re-sends the whole conversation, so a
 * late turn costs several times an early one. Only a new chat resets
 * that, which is why it is offered as an automatic policy and not just a
 * button. It is also the one option that loses something (the agent
 * forgets), so "ask" hands the choice back rather than spending — or
 * forgetting — on the user's behalf.
 *
 * Guarded against loops: never triggered by the compact turn itself.
 */
export function autoCompactDecision(
  tab: CompactableTab,
  settings: {
    readonly autoCompact: AutoCompactPolicy;
    readonly autoCompactThreshold: number;
  },
): AutoCompactDecision {
  if (!tab.usage || settings.autoCompact === "off") return { action: "nothing" };

  const full = tab.usage.used / tab.usage.size;
  if (full < settings.autoCompactThreshold) {
    // Dropped back under the ceiling (a compaction, or a new session):
    // the question no longer stands.
    return tab.contextFullPercent === undefined
      ? { action: "nothing" }
      : { action: "dismiss" };
  }

  const command = COMPACT_COMMAND[tab.project.provider];
  const lastUserMessage = [...tab.messages].reverse().find((m) => m.role === "user");
  if (lastUserMessage?.text === command) return { action: "nothing" }; // that WAS it

  const percent = Math.round(full * 100);
  if (settings.autoCompact === "ask") return { action: "ask", percent };
  if (settings.autoCompact === "newChat") return { action: "newChat", percent };
  return { action: "compact", percent, command };
}

/** Whether acting on this decision starts a turn of its own — in which
 *  case the tab is spoken for and nothing else may send into it. */
export function claimsTheTurn(decision: AutoCompactDecision): boolean {
  return decision.action === "compact" || decision.action === "newChat";
}
