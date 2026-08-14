import { defaultsFromProject, newProject } from "../entities/project";
import type { SubtaskScope } from "../entities/subtask";
import {
  normalizedBoundaries,
  sameScope,
  subtaskScopeProblem,
} from "../entities/subtask";
import type { AgentGateway } from "../ports/agentGateway";
import type { WorkspaceStore } from "../ports/workspacePort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import type { IdGenerator } from "./openProject";
import { persistWorkspace } from "./persistWorkspace";
import { warmTab } from "./warmSessions";

/**
 * Use case — the subtasks panel's verbs: open a scoped tab on the folder
 * a tab already works, and change a subtask's scope. A subtask tab is an
 * ordinary project tab whose `subtask` names the authority its agent
 * gets; there is nothing on disk behind it.
 */
export class Subtasks {
  constructor(
    private readonly store: Store,
    private readonly workspaceStore: WorkspaceStore,
    private readonly agentGateway: AgentGateway,
    private readonly newId: IdGenerator,
  ) {}

  /**
   * Open a new subtask tab beside `sourceTabId`, on the same folder.
   * Returns what is wrong with the request, or undefined when it opened.
   */
  async open(sourceTabId: string, scope: SubtaskScope): Promise<string | undefined> {
    const normalized = normalizedScope(scope);
    const problem = subtaskScopeProblem(normalized);
    if (problem) return problem;

    const state = this.store.getState();
    const source = tabById(state, sourceTabId);
    if (!source) return "Unknown tab.";

    // The source tab's settings seed the new one — same reasoning as a
    // worktree forked from a tab: the subtask is part of that task. The
    // scope is the one thing that never inherits; it is the whole point.
    const project = newProject(
      this.newId(),
      source.project.path,
      defaultsFromProject(source.project),
      source.project.worktreeOf,
      normalized,
    );
    this.store.dispatch({ type: "tab/opened", project });
    warmTab(this.store, this.agentGateway, project.id);
    await persistWorkspace(this.store.getState(), this.workspaceStore);
    return undefined;
  }

  /**
   * Re-scope an existing subtask tab. The scope is part of the backend's
   * session spec, so warming after the change retires the live agent and
   * respawns it under the new authority — spawn-time sandbox flags can't
   * be renegotiated with a running process.
   */
  async changeScope(tabId: string, scope: SubtaskScope): Promise<string | undefined> {
    const normalized = normalizedScope(scope);
    const problem = subtaskScopeProblem(normalized);
    if (problem) return problem;

    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return "Unknown tab.";
    if (!tab.project.subtask) return "Not a subtask tab.";
    if (sameScope(tab.project.subtask, normalized)) return undefined;

    this.store.dispatch({ type: "subtask/scopeChanged", tabId, scope: normalized });
    warmTab(this.store, this.agentGateway, tabId);
    await persistWorkspace(this.store.getState(), this.workspaceStore);
    return undefined;
  }
}

/** The scope as it should live in state: boundary folders cleaned up. */
function normalizedScope(scope: SubtaskScope): SubtaskScope {
  return scope.access === "boundary"
    ? { access: "boundary", boundaries: normalizedBoundaries(scope.boundaries ?? []) }
    : { access: "read-only" };
}
