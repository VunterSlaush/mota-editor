import { defaultsFromProject, newProject } from "../entities/project";
import type { RemovalCheck } from "../entities/worktree";
import {
  deriveWorktreePath,
  effectiveProvisioning,
  removalCheck,
  samePath,
} from "../entities/worktree";
import type { AgentGateway } from "../ports/agentGateway";
import type {
  GitPort,
  GitWorktree,
  WorktreeAddMode,
  WorktreeRemoveMode,
} from "../ports/gitPort";
import type { WorkspaceStore } from "../ports/workspacePort";
import type {
  ProvisionReport,
  WorktreeProvisioning,
} from "../ports/worktreeProvisioning";
import { projectDefaults, tabById } from "../state/appState";
import type { Store } from "../state/store";
import type { CloseProject } from "./closeProject";
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
    private readonly provisioning: WorktreeProvisioning,
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
   * `sourceTabId` is the tab the worktree was opened from; its settings
   * seed the new tab unless the user turned that off.
   */
  async open(
    worktreePath: string,
    mainPath: string,
    sourceTabId?: string,
  ): Promise<void> {
    const state = this.store.getState();
    const existing = state.tabs.find((t) => samePath(t.project.path, worktreePath));
    if (existing) {
      this.store.dispatch({ type: "tab/activated", tabId: existing.project.id });
      return;
    }

    const source = sourceTabId ? tabById(state, sourceTabId) : null;
    const defaults =
      source && state.settings.worktrees.inheritFromSourceTab
        ? defaultsFromProject(source.project)
        : projectDefaults(state.settings);

    const worktreeOf = samePath(worktreePath, mainPath) ? undefined : mainPath;
    // The provisioning list travels regardless of inheritFromSourceTab:
    // that toggle is a preference, this is correctness — removal must
    // take back exactly the list this worktree was stocked with, even
    // after a restart, so the worktree's own project carries it.
    const project = newProject(
      this.newId(),
      worktreePath,
      { ...defaults, provisioningOverride: source?.project.provisioningOverride },
      worktreeOf,
    );
    this.store.dispatch({ type: "tab/opened", project });
    const activeTabId = this.store.getState().activeTabId;
    if (activeTabId) warmTab(this.store, this.agentGateway, activeTabId);
    await persistWorkspace(this.store.getState(), this.workspaceStore);
  }

  /**
   * Create a worktree for `branch` at the derived sibling location and
   * open it. Failures come back as messages for the picker to show.
   *
   * `base` is where a brand-new branch starts, and only "new" mode reads
   * it: empty leaves the start point to git, which is this tab's HEAD.
   */
  async create(
    tabId: string,
    branch: string,
    mode: WorktreeAddMode,
    base = "",
  ): Promise<GitActionResult> {
    const state = this.store.getState();
    const tab = tabById(state, tabId);
    if (!tab) return { ok: false, message: "Unknown tab." };
    const { container, remote } = state.settings.worktrees;
    try {
      const worktrees = await this.git.worktrees(tab.project.path);
      const mainPath = worktrees.find((w) => w.main)?.path ?? tab.project.path;
      const target = deriveWorktreePath(
        mainPath,
        branch,
        worktrees.map((w) => w.path),
        container,
      );
      const message = await this.git.worktreeAdd(
        tab.project.path,
        target,
        branch,
        mode,
        remote,
        base,
      );
      await this.open(target, mainPath, tabId);
      // Stocking the worktree is not part of creating it: the tab is
      // already usable, and a folder that failed to copy must never make
      // the picker claim the worktree was not made.
      void this.provision(target, mainPath);
      return { ok: true, message };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  /**
   * Put the configured heavy folders in place, reporting progress on the
   * worktree's own tab. Safe to run again: every step is idempotent, so
   * this doubles as the retry after a failure.
   */
  async provision(worktreePath: string, mainPath: string): Promise<void> {
    const state = this.store.getState();
    const tab = state.tabs.find((t) => samePath(t.project.path, worktreePath));
    if (!tab) return;
    const entries = effectiveProvisioning(
      tab.project.provisioningOverride,
      state.settings.worktrees.provisioning,
    ).filter((e) => e.strategy !== "skip");
    if (entries.length === 0) return;

    const tabId = tab.project.id;
    this.store.dispatch({ type: "worktree/preparing", tabId });
    try {
      const report = await this.provisioning.provision(mainPath, worktreePath, entries);
      this.store.dispatch({
        type: "worktree/prepared",
        tabId,
        problem: provisionProblem(report),
      });
    } catch (e) {
      this.store.dispatch({
        type: "worktree/prepared",
        tabId,
        problem: e instanceof Error ? e.message : String(e),
      });
    }
  }
}

/**
 * What to tell the user about a finished provision, or undefined when
 * there is nothing worth saying. Only failures are worth saying: a
 * folder the main checkout never had is skipped, not broken.
 */
export function provisionProblem(report: ProvisionReport): string | undefined {
  const failed = report.entries.filter((e) => e.outcome === "failed");
  if (failed.length === 0) return undefined;
  const detail = failed.map((e) => `${e.path}: ${e.message}`).join("; ");
  return failed.length === 1
    ? `Could not prepare ${detail}`
    : `Could not prepare ${failed.length} folders — ${detail}`;
}

/**
 * Use case — removing a worktree and reclaiming its disk.
 *
 * Kept apart from `Worktrees` because it is the one destructive verb
 * here, and because it needs `CloseProject`: the tab must be torn down
 * *before* the folder goes. That ordering is not tidiness. A mid-turn
 * agent is writing into the directory, and ending its session kills the
 * terminals whose working directory is inside it — on Windows an open
 * handle makes the delete fail outright.
 */
export class RemoveWorktree {
  constructor(
    private readonly store: Store,
    private readonly git: GitPort,
    private readonly provisioning: WorktreeProvisioning,
    private readonly closeProject: CloseProject,
  ) {}

  /**
   * Whether `worktreePath` can go, and what to say first. Cheap enough
   * to call when a row is focused: two git reads, no writes.
   */
  async check(tabId: string, worktreePath: string): Promise<RemovalCheck> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab)
      return {
        needsForce: false,
        blockers: ["Unknown tab."],
        blocked: true,
        reclaimable: false,
      };

    const worktrees = await this.git.worktrees(tab.project.path).catch(() => []);
    const target = worktrees.find((w) => samePath(w.path, worktreePath));
    if (!target) {
      return {
        needsForce: false,
        blockers: ["Not a worktree of this repository."],
        blocked: true,
        reclaimable: false,
      };
    }
    // The worktree's own status: `run_git` is `-C`-based, so asking the
    // worktree asks about the worktree. Ignored files (node_modules, a
    // build target) appear in neither this nor git's own check, so the
    // heavy folders never provoke the force prompt.
    const changes = await this.git.changes(worktreePath).catch(() => []);
    const merged = await this.isMerged(tab.project.path, target.branch);
    return removalCheck(changes.length, target, merged);
  }

  /**
   * Close the tab, take the links back, remove the worktree, prune.
   *
   * Un-provisioning first is defence in depth. Removal is already safe —
   * everything that recurses uses `lstat`, so a symlink is unlinked
   * rather than followed into the main checkout — but that guarantee is
   * one platform quirk away from costing someone their `node_modules`,
   * and taking the links out first makes it moot.
   */
  async execute(
    tabId: string,
    worktreePath: string,
    mode: WorktreeRemoveMode,
  ): Promise<GitActionResult> {
    const state = this.store.getState();
    const tab = tabById(state, tabId);
    if (!tab) return { ok: false, message: "Unknown tab." };
    const mainPath = tab.project.worktreeOf ?? tab.project.path;
    if (samePath(worktreePath, mainPath)) {
      return { ok: false, message: "The main checkout cannot be removed." };
    }

    const open = state.tabs.find((t) => samePath(t.project.path, worktreePath));
    if (open) await this.closeProject.execute(open.project.id);

    // The worktree's own tab carries the list it was stocked with; a
    // sibling tab of the same repo is the next best witness; the app
    // default is only a fallback (and unprovision is lstat-safe anyway).
    const override =
      open?.project.provisioningOverride ?? tab.project.provisioningOverride;
    const paths = effectiveProvisioning(
      override,
      state.settings.worktrees.provisioning,
    ).map((e) => e.path);
    await this.provisioning.unprovision(worktreePath, paths).catch(() => []);

    try {
      const message = await this.git.worktreeRemove(mainPath, worktreePath, mode);
      // The cheap moment to clear any other stale bookkeeping too.
      await this.git.worktreePrune(mainPath).catch(() => "");
      return { ok: true, message };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }
  }

  private async isMerged(mainPath: string, branch: string): Promise<boolean> {
    if (!branch) return false; // detached: nothing to call merged
    for (const base of ["origin/HEAD", "origin/main", "main"]) {
      try {
        const merged = await this.git.branchesMerged(mainPath, base);
        return merged.some((b) => b.name === branch);
      } catch {
        // That base does not exist here; try the next spelling.
      }
    }
    return false;
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
