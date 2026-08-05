import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import type { AppState } from "../state/appState";

/**
 * Use case (shared step) — project the in-memory state onto the persisted
 * shape and hand it to the WorkspaceStore port. Messages are deliberately
 * not persisted in v1; provider session ids are, so chats resume.
 */
export function toPersisted(state: AppState): PersistedWorkspace {
  return {
    projects: state.tabs.map((t) => ({
      id: t.project.id,
      path: t.project.path,
      provider: t.project.provider,
      mode: t.project.mode,
      permission: t.project.permission,
      model: t.project.model,
      effort: t.project.effort,
      verbose: t.project.verbose,
      providerSessions: t.project.providerSessions,
    })),
    activeTabId: state.activeTabId,
    settings: state.settings,
  };
}

export async function persistWorkspace(
  state: AppState,
  store: WorkspaceStore,
): Promise<void> {
  try {
    await store.save(toPersisted(state));
  } catch {
    // Persistence is best-effort; the session keeps working without it.
  }
}
