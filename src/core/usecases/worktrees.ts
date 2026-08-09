import { newProject } from "../entities/project";
import { deriveWorktreePath, samePath } from "../entities/worktree";
import type { AgentGateway } from "../ports/agentGateway";
import type { GitPort, GitWorktree, WorktreeAddMode } from "../ports/gitPort";
import type { WorkspaceStore } from "../ports/workspacePort";
import { projectDefaults, tabById } from "../state/appState";
import type { Store } from "../state/store";
import type { GitActionResult } from "./gitActions";
import type { IdGenerator } from "./openProject";
import { persistWorkspace } from "./persistWorkspace";
import { warmTab } from "./warmSessions";

/** A worktree decorated with what this workspace knows about it. */
export interface WorktreeItem extends GitWorktree {
  /** Tab already showing this worktree, if any. */
  readonly openTabId: string | null;
  /** True when this is the asking tab's own checkout. */
  readonly current: boolean;
}

/**
 * Use case — the worktree picker's verbs: list the repository's
 * checkouts, open one as a tab, create one and open it. A worktree tab
 * is an ordinary project tab whose `worktreeOf` names the main checkout.
 */
export class Worktrees {
  constructor(
    private readonly store: Store,
    private readonly git: GitPort,
    private readonly workspaceStore: WorkspaceStore,
    private readonly agentGateway: AgentGateway,
    private readonly newId: IdGenerator,
  ) {}

  /** All checkouts, main first. Empty when the folder isn't a repo. */
  async list(tabId: string): Promise<WorktreeItem[]> {
    const state = this.store.getState();
    const tab = tabById(state, tabId);
    if (!tab) return [];
    let worktrees: GitWorktree[];
    try {
      worktrees = await this.git.worktrees(tab.project.path);
    } catch {
      return []; // not a repository — a normal state, not an error
    }
    return worktrees.map((w) => ({
      ...w,
      openTabId:
        state.tabs.find((t) => samePath(t.project.path, w.path))?.project.id ?? null,
      current: samePath(tab.project.path, w.path),
    }));
  }

  /**
   * Bring a worktree onto the tab bar: activate its tab when one exists
   * (checked with `samePath` — the reducer's dedup is exact-string and
   * git's slashes rarely match the OS dialog's), otherwise open one.
   */
  async open(worktreePath: string, mainPath: string): Promise<void> {
    const state = this.store.getState();
    const existing = state.tabs.find((t) => samePath(t.project.path, worktreePath));
    if (existing) {
      this.store.dispatch({ type: "tab/activated", tabId: existing.project.id });
      return;
    }

    const worktreeOf = samePath(worktreePath, mainPath) ? undefined : mainPath;
    this.store.dispatch({
      type: "tab/opened",
      project: newProject(
        this.newId(),
        worktreePath,
        projectDefaults(state.settings),
        worktreeOf,
      ),
    });
    const activeTabId = this.store.getState().activeTabId;
    if (activeTabId) warmTab(this.store, this.agentGateway, activeTabId);
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }

  /**
   * Create a worktree for `branch` at the derived sibling location and
   * open it. Failures come back as messages for the picker to show.
   */
  async create(
    tabId: string,
    branch: string,
    mode: WorktreeAddMode,
  ): Promise<GitActionResult> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return { ok: false, message: "Unknown tab." };
    try {
      const worktrees = await this.git.worktrees(tab.project.path);
      const mainPath = worktrees.find((w) => w.main)?.path ?? tab.project.path;
      const target = deriveWorktreePath(
        mainPath,
        branch,
        worktrees.map((w) => w.path),
      );
      const message = await this.git.worktreeAdd(tab.project.path, target, branch, mode);
      await this.open(target, mainPath);
      return { ok: true, message };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }
}

/**
 * The main checkout's path when `path` is a linked worktree, undefined
 * for the main checkout itself or a folder that is no repository. Git
 * always prints the main worktree first.
 */
export async function detectWorktreeOf(
  git: GitPort,
  path: string,
): Promise<string | undefined> {
  try {
    const worktrees = await git.worktrees(path);
    const main = worktrees.find((w) => w.main);
    if (!main || samePath(main.path, path)) return undefined;
    return main.path;
  } catch {
    return undefined;
  }
}
