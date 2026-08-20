import type { AgentGateway } from "../ports/agentGateway";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import { agentServers } from "./agentServers";

/**
 * Use case (shared step) — a new conversation means a NEW AGENT CONTEXT,
 * not just an empty screen: the backend session is ended (so the agent
 * forgets), the resume id/usage/commands are dropped, and a fresh session
 * pre-warms so the first message stays fast.
 *
 * A free function, like `warmTab` and `persistWorkspace`, because four
 * different callers need it — the header button, the History panel, the
 * context-full bar, and the auto-compact policy that starts a new chat
 * rather than compacting. Passing SessionHistory into SendPrompt to reach
 * it would have coupled two large use cases for one line.
 *
 * No-op while a turn is running: clearing the screen out from under a
 * live turn would orphan it.
 */
export async function startNewChat(
  store: Store,
  agentGateway: AgentGateway,
  tabId: string,
): Promise<void> {
  const before = tabById(store.getState(), tabId);
  if (!before || before.busy) return;
  const provider = before.project.provider;

  await agentGateway.endSession(tabId).catch(() => undefined);
  store.dispatch({ type: "chat/cleared", tabId });
  store.dispatch({ type: "chat/sessionReset", tabId, provider });

  // Read the tab back: the reset folds in any model/effort change that
  // was deferred during the last conversation, and the fresh session
  // must boot with it — that deferral was made for this moment.
  const state = store.getState();
  const tab = tabById(state, tabId);
  if (!tab) return;
  const { path, model, effort, mcpOverrides, subtask } = tab.project;
  void agentGateway
    .warmSession(
      tabId,
      provider,
      path,
      model,
      effort,
      agentServers(state, provider, mcpOverrides),
      subtask,
    )
    .catch(() => undefined); // warm-up is best-effort
}
