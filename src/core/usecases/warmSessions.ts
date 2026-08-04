import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import type { AgentGateway } from "../ports/agentGateway";

/**
 * Use case (shared step) — pre-start a tab's agent session with its
 * current provider/model so the first message answers immediately.
 * Fire-and-forget by design: a warm-up failure is silent, because the
 * real turn reports problems with full context.
 */
export function warmTab(store: Store, agentGateway: AgentGateway, tabId: string): void {
  const tab = tabById(store.getState(), tabId);
  if (!tab) return;
  const { provider, path, model, effort } = tab.project;
  void agentGateway.warmSession(tabId, provider, path, model, effort).catch(() => undefined);
}

/** Warm every open tab (app start). */
export function warmAllTabs(store: Store, agentGateway: AgentGateway): void {
  for (const tab of store.getState().tabs) {
    warmTab(store, agentGateway, tab.project.id);
  }
}
