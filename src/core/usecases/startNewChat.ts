import type { AgentGateway } from "../ports/agentGateway";
import { type TabState, tabById } from "../state/appState";
import type { Store } from "../state/store";
import { declineParkedPlan } from "./planApproval";
import { warmTab } from "./warmSessions";

/**
 * Where the conversation being replaced goes. Named as a collaborator
 * rather than imported so this step depends on the idea, not on the use
 * case that implements it — `RetiredChats` is the implementation.
 */
export interface ChatRetirement {
  retire(tab: TabState): void;
}

/**
 * Use case (shared step) — a new conversation means a NEW AGENT CONTEXT,
 * not just an empty screen: the old chat is taken off the tab, the resume
 * id/usage/commands are dropped, and a fresh session pre-warms so the
 * first message stays fast.
 *
 * A free function, like `warmTab` and `persistWorkspace`, because four
 * different callers need it — the header button, the History panel, the
 * context-full bar, and the auto-compact policy that starts a new chat
 * rather than compacting. Passing SessionHistory into SendPrompt to reach
 * it would have coupled two large use cases for one line.
 *
 * The old agent is RETIRED, not killed: it may still be watching
 * something it was asked to report on, and that report belongs to the
 * conversation that asked for it. See ADR-0016.
 *
 * No-op while a turn is running: clearing the screen out from under a
 * live turn would orphan it.
 */
export async function startNewChat(
  store: Store,
  agentGateway: AgentGateway,
  tabId: string,
  retiredChats?: ChatRetirement,
): Promise<void> {
  const before = tabById(store.getState(), tabId);
  if (!before || before.busy) return;
  const provider = before.project.provider;

  // A plan-parked turn is idle on screen and still OPEN on the agent's
  // side. Retiring underneath it would leave the agent waiting on an
  // answer nobody can give any more.
  await declineParkedPlan(store, agentGateway, tabId);

  // Park the agent BEFORE handing the conversation over: the hand-over
  // ends an agent it decides is not worth keeping, and there has to be a
  // parked one for that to reach. It also fixes the capture below at the
  // last moment the conversation is whole — the tab is still painting
  // whatever the old session says right up to this call.
  await agentGateway.retireSession(tabId).catch(() => undefined);
  retiredChats?.retire(tabById(store.getState(), tabId) ?? before);

  store.dispatch({ type: "chat/cleared", tabId });
  store.dispatch({ type: "chat/sessionReset", tabId, provider });

  // Warm from the tab as the reset leaves it: it folds in any model or
  // effort change that was deferred during the last conversation, and it
  // carries the new chat id that the fresh session's events are stamped
  // with. That deferral was made for this moment.
  warmTab(store, agentGateway, tabId);
}
