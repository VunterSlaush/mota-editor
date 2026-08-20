import { defaultsFromProject, newProject } from "../entities/project";
import type { BoundaryPreset, SubtaskScope } from "../entities/subtask";
import {
  normalizedBoundaries,
  normalizedPreset,
  presetProblem,
  sameScope,
  subtaskScopeProblem,
} from "../entities/subtask";
import type { AgentGateway } from "../ports/agentGateway";
import type { BoundarySuggestions } from "../ports/boundarySuggestions";
import type { WorkspaceStore } from "../ports/workspacePort";
import type { WorktreeProvisioning } from "../ports/worktreeProvisioning";
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
    /** Where the project's folders come from — the same shallow scan the
     *  worktree settings offer, rather than a second one of our own. */
    private readonly folders: WorktreeProvisioning,
    private readonly suggestions: BoundarySuggestions,
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

  /**
   * Replace the project's named areas. No agent is touched: a preset is
   * a shortcut for picking folders, not authority anyone holds — a tab
   * only gets narrower when its own scope changes.
   */
  async savePresets(
    tabId: string,
    presets: readonly BoundaryPreset[],
  ): Promise<string | undefined> {
    if (!tabById(this.store.getState(), tabId)) return "Unknown tab.";
    const normalized = presets.map(normalizedPreset);
    const problem = normalized.map(presetProblem).find(Boolean);
    if (problem) return problem;

    this.store.dispatch({ type: "subtask/presetsChanged", tabId, presets: normalized });
    await persistWorkspace(this.store.getState(), this.workspaceStore);
    return undefined;
  }

  /**
   * Ask an agent to name this project's areas and keep the ones that
   * survive validation. Costs the user tokens, so the caller is a button
   * that said as much before it ran; the answer is returned rather than
   * saved, because a suggestion is a draft until someone accepts it.
   */
  async suggestPresets(tabId: string): Promise<SuggestedPresets> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return { presets: [], problem: "Unknown tab." };
    try {
      const folders = await this.folders.folderCandidates(tab.project.path);
      const suggested = await this.suggestions.suggest(
        tab.project.provider,
        tab.project.path,
        folders,
      );
      const presets = suggested
        .map((s) => normalizedPreset({ ...s, id: this.newId() }))
        .filter((p) => !presetProblem(p));
      return presets.length > 0
        ? { presets }
        : { presets: [], problem: "Nothing usable came back — add the folders by hand." };
    } catch (e) {
      return { presets: [], problem: e instanceof Error ? e.message : String(e) };
    }
  }
}

/** What a suggestion run produced, or why it produced nothing. */
export interface SuggestedPresets {
  readonly presets: readonly BoundaryPreset[];
  readonly problem?: string;
}

/** The scope as it should live in state: boundary folders cleaned up. */
function normalizedScope(scope: SubtaskScope): SubtaskScope {
  return scope.access === "boundary"
    ? { access: "boundary", boundaries: normalizedBoundaries(scope.boundaries ?? []) }
    : { access: "read-only" };
}
