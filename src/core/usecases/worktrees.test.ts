import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { ProvisionEntry } from "../entities/worktree";
import type { AgentGateway } from "../ports/agentGateway";
import type { GitPort, GitWorktree } from "../ports/gitPort";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import type {
  ProvisionReport,
  WorktreeProvisioning,
} from "../ports/worktreeProvisioning";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import type { CloseProject } from "./closeProject";
import {
  detectWorktreeOf,
  provisionProblem,
  RemoveWorktree,
  Worktrees,
} from "./worktrees";

const DEFAULTS = projectDefaults(defaultSettings);

function worktree(partial: Partial<GitWorktree> & { path: string }): GitWorktree {
  return {
    branch: "main",
    head: "abc1234",
    main: false,
    bare: false,
    locked: false,
    prunable: false,
    ...partial,
  };
}

/** Test double — only the worktree verbs matter here. */
class FakeGit implements GitPort {
  worktreeList: GitWorktree[] = [];
  notARepo = false;
  failWorktreeAddWith: string | null = null;
  added: Array<{ path: string; branch: string; mode: string; remote: string }> = [];

  async worktrees(): Promise<GitWorktree[]> {
    if (this.notARepo) throw new Error("not a repo");
    return this.worktreeList;
  }
  async worktreeAdd(
    _p: string,
    path: string,
    branch: string,
    mode: string,
    remote: string,
  ) {
    if (this.failWorktreeAddWith) throw new Error(this.failWorktreeAddWith);
    this.added.push({ path, branch, mode, remote });
    return "Preparing worktree";
  }

  async changes() {
    return Array.from({ length: this.changedFiles }, (_, n) => ({
      path: `f${n}.ts`,
      staged: false,
      unstaged: true,
      label: "modified",
    }));
  }
  async log() {
    return [];
  }
  async upstream() {
    return null;
  }
  async branches() {
    return [];
  }
  async remoteUrl() {
    return "";
  }
  async currentBranch() {
    return "";
  }
  async listFiles() {
    return [];
  }
  async diff() {
    return "";
  }
  async stage() {}
  async unstage() {}
  async commit() {
    return "";
  }
  async checkout() {
    return "";
  }
  async push() {
    return "";
  }
  async pull() {
    return "";
  }
  async fetch() {
    return "";
  }

  removed: Array<{ path: string; mode: string }> = [];
  pruned = 0;
  mergedBranches: string[] = [];
  changedFiles = 0;
  failRemoveWith: string | null = null;

  async worktreeRemove(_p: string, worktreePath: string, mode: string) {
    if (this.failRemoveWith) throw new Error(this.failRemoveWith);
    this.removed.push({ path: worktreePath, mode });
    return "Removing worktree";
  }
  async worktreePrune() {
    this.pruned += 1;
    return "";
  }
  async branchesMerged() {
    return this.mergedBranches.map((name) => ({ name, current: false }));
  }
}

class FakeWorkspaceStore implements WorkspaceStore {
  saved: PersistedWorkspace | null = null;
  async load() {
    return this.saved;
  }
  async save(workspace: PersistedWorkspace) {
    this.saved = workspace;
  }
}

class FakeAgentGateway {
  warms = 0;
  async warmSession(): Promise<void> {
    this.warms += 1;
  }
}

class FakeProvisioning implements WorktreeProvisioning {
  calls: Array<{ mainPath: string; worktreePath: string; paths: string[] }> = [];
  failWith: string | null = null;
  report: ProvisionReport | null = null;
  private gate: Promise<void> | null = null;
  private open: (() => void) | null = null;

  /** Make the next provision hang until the returned function is called. */
  hold(): () => void {
    this.gate = new Promise<void>((resolve) => {
      this.open = resolve;
    });
    return () => this.open?.();
  }

  async provision(
    mainPath: string,
    worktreePath: string,
    entries: readonly ProvisionEntry[],
  ): Promise<ProvisionReport> {
    this.calls.push({ mainPath, worktreePath, paths: entries.map((e) => e.path) });
    if (this.gate) await this.gate;
    if (this.failWith) throw new Error(this.failWith);
    return (
      this.report ?? {
        worktreePath,
        entries: entries.map((e) => ({
          path: e.path,
          strategy: e.strategy,
          outcome: "copied",
          message: "",
        })),
        ok: true,
      }
    );
  }
  unprovisioned: Array<{ path: string; paths: string[] }> = [];
  async unprovision(path: string, paths: readonly string[]) {
    this.unprovisioned.push({ path, paths: [...paths] });
    return [...paths];
  }
  async supportsCow() {
    return true;
  }
  async folderCandidates() {
    return [];
  }
  async diskUsage() {
    return {
      ownBytes: 0,
      sharedBytes: 0,
      apparentBytes: 0,
      entries: [],
      truncated: false,
    };
  }
}

function setup() {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "C:\\repos\\app", DEFAULTS),
  });
  const git = new FakeGit();
  const workspace = new FakeWorkspaceStore();
  const gateway = new FakeAgentGateway();
  const provisioning = new FakeProvisioning();
  let counter = 0;
  const worktrees = new Worktrees(
    store,
    git,
    workspace,
    gateway as unknown as AgentGateway,
    () => `id-${++counter}`,
    provisioning,
  );
  return { store, git, workspace, gateway, provisioning, worktrees };
}

/** `create` fires provisioning without awaiting it; let it settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("Worktrees.list", () => {
  it("marks the asking tab's checkout and already-open tabs, across slash styles", async () => {
    const { store, git, worktrees } = setup();
    git.worktreeList = [
      worktree({ path: "C:/repos/app", main: true }),
      worktree({ path: "C:/repos/app-worktrees/dev", branch: "dev" }),
    ];
    const items = await worktrees.list("t1");
    // Git prints forward slashes; the tab was opened with backslashes.
    expect(items[0].current).toBe(true);
    expect(items[0].openTabId).toBe("t1");
    expect(items[1].current).toBe(false);
    expect(items[1].openTabId).toBeNull();
    expect(store.getState().tabs).toHaveLength(1);
  });

  it("treats a folder that is not a repository as having no worktrees", async () => {
    const { git, worktrees } = setup();
    git.notARepo = true;
    expect(await worktrees.list("t1")).toEqual([]);
  });
});

describe("Worktrees.open", () => {
  it("opens a new tab that remembers its main checkout, and persists it", async () => {
    const { store, workspace, gateway, worktrees } = setup();
    await worktrees.open("C:/repos/app-worktrees/dev", "C:/repos/app");

    const tabs = store.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[1].project.worktreeOf).toBe("C:/repos/app");
    expect(store.getState().activeTabId).toBe(tabs[1].project.id);
    expect(gateway.warms).toBe(1);
    expect(workspace.saved?.projects[1].worktreeOf).toBe("C:/repos/app");
  });

  it("activates an existing tab instead of duplicating it", async () => {
    const { store, worktrees } = setup();
    await worktrees.open("C:/repos/app-worktrees/dev", "C:/repos/app");
    const opened = store.getState().tabs[1].project.id;
    store.dispatch({ type: "tab/activated", tabId: "t1" });

    // Same folder, git's slash style vs the stored one.
    await worktrees.open("C:\\repos\\app-worktrees\\dev\\", "C:/repos/app");
    expect(store.getState().tabs).toHaveLength(2);
    expect(store.getState().activeTabId).toBe(opened);
  });

  it("leaves the main checkout unmarked when opened as a tab", async () => {
    const { store, worktrees } = setup();
    store.dispatch({ type: "tab/closed", tabId: "t1" });
    await worktrees.open("C:/repos/app", "C:/repos/app");
    expect(store.getState().tabs[0].project.worktreeOf).toBeUndefined();
  });
});

describe("Worktrees.create", () => {
  it("derives a sibling path from the main checkout and opens the result", async () => {
    const { store, git, worktrees } = setup();
    git.worktreeList = [
      worktree({ path: "C:/repos/app", main: true }),
      worktree({ path: "C:/repos/app-worktrees/dev", branch: "dev" }),
    ];
    const result = await worktrees.create("t1", "feature/login", "existing");

    expect(result.ok).toBe(true);
    expect(git.added).toEqual([
      {
        path: "C:/repos/app-worktrees/feature-login",
        branch: "feature/login",
        mode: "existing",
        remote: "origin",
      },
    ]);
    const tabs = store.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[1].project.worktreeOf).toBe("C:/repos/app");
    expect(tabs[1].project.name).toBe("feature-login");
  });

  it("suffixes the path when the branch already has a similarly named worktree", async () => {
    const { git, worktrees } = setup();
    git.worktreeList = [
      worktree({ path: "C:/repos/app", main: true }),
      worktree({ path: "C:/repos/app-worktrees/dev", branch: "dev" }),
    ];
    await worktrees.create("t1", "dev", "new");
    expect(git.added[0].path).toBe("C:/repos/app-worktrees/dev-2");
    expect(git.added[0].mode).toBe("new");
  });

  it("puts the worktree in the configured container", async () => {
    const { store, git, worktrees } = setup();
    store.dispatch({
      type: "settings/changed",
      patch: {
        worktrees: { ...defaultSettings.worktrees, container: "/volumes/fast/trees" },
      },
    });
    git.worktreeList = [worktree({ path: "C:/repos/app", main: true })];
    await worktrees.create("t1", "dev", "new");
    expect(git.added[0].path).toBe("/volumes/fast/trees/dev");
  });

  it("tracks remote-only branches from the configured remote", async () => {
    const { store, git, worktrees } = setup();
    store.dispatch({
      type: "settings/changed",
      patch: { worktrees: { ...defaultSettings.worktrees, remote: "upstream" } },
    });
    git.worktreeList = [worktree({ path: "C:/repos/app", main: true })];
    await worktrees.create("t1", "dev", "remote");
    expect(git.added[0].remote).toBe("upstream");
  });

  it("seeds the new tab from the tab it was created off", async () => {
    const { store, git, worktrees } = setup();
    store.dispatch({ type: "tab/providerChanged", tabId: "t1", provider: "gemini" });
    store.dispatch({ type: "tab/modeChanged", tabId: "t1", mode: "plan" });
    git.worktreeList = [worktree({ path: "C:/repos/app", main: true })];
    await worktrees.create("t1", "dev", "new");

    const opened = store.getState().tabs[1].project;
    expect(opened.provider).toBe("gemini");
    expect(opened.mode).toBe("plan");
  });

  it("falls back to the app defaults when inheriting is turned off", async () => {
    const { store, git, worktrees } = setup();
    store.dispatch({ type: "tab/modeChanged", tabId: "t1", mode: "plan" });
    store.dispatch({
      type: "settings/changed",
      patch: {
        worktrees: { ...defaultSettings.worktrees, inheritFromSourceTab: false },
      },
    });
    git.worktreeList = [worktree({ path: "C:/repos/app", main: true })];
    await worktrees.create("t1", "dev", "new");

    expect(store.getState().tabs[1].project.mode).toBe(DEFAULTS.mode);
  });

  it("returns git's error as a message and opens nothing", async () => {
    const { store, git, worktrees } = setup();
    git.worktreeList = [worktree({ path: "C:/repos/app", main: true })];
    git.failWorktreeAddWith = "fatal: 'dev' is already checked out";
    const result = await worktrees.create("t1", "dev", "existing");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("already checked out");
    expect(store.getState().tabs).toHaveLength(1);
  });
});

describe("Worktrees provisioning", () => {
  /** Nothing is provisioned by default, so these tests say what is. */
  async function created() {
    const made = setup();
    made.git.worktreeList = [worktree({ path: "C:/repos/app", main: true })];
    made.store.dispatch({
      type: "settings/changed",
      patch: {
        worktrees: {
          ...defaultSettings.worktrees,
          provisioning: [
            { path: "node_modules", strategy: "clone" },
            { path: "src-tauri/target", strategy: "skip" },
          ],
        },
      },
    });
    return made;
  }

  it("stocks the new worktree with everything not set to skip", async () => {
    const { git, provisioning, worktrees } = await created();
    await worktrees.create("t1", "dev", "new");
    await settle();

    expect(provisioning.calls).toHaveLength(1);
    expect(provisioning.calls[0].mainPath).toBe("C:/repos/app");
    expect(provisioning.calls[0].worktreePath).toBe(git.added[0].path);
    // src-tauri/target is set to skip, so only node_modules is asked for.
    expect(provisioning.calls[0].paths).toEqual(["node_modules"]);
  });

  it("does not call the disk at all when everything is set to skip", async () => {
    const { store, provisioning, worktrees } = await created();
    store.dispatch({
      type: "settings/changed",
      patch: {
        worktrees: {
          ...defaultSettings.worktrees,
          provisioning: [{ path: "node_modules", strategy: "skip" }],
        },
      },
    });
    await worktrees.create("t1", "dev", "new");
    await settle();
    expect(provisioning.calls).toHaveLength(0);
  });

  it("creates the worktree successfully even when stocking it fails", async () => {
    const { store, provisioning, worktrees } = await created();
    provisioning.failWith = "No space left on device";
    const result = await worktrees.create("t1", "dev", "new");
    await settle();

    expect(result.ok).toBe(true); // the worktree exists; the copy did not
    expect(store.getState().tabs).toHaveLength(2);
    expect(store.getState().tabs[1].preparing).toBe(false);
    expect(store.getState().tabs[1].preparingProblem).toContain("No space left");
  });

  it("prefers the project's own list over the app default", async () => {
    const { store, provisioning, worktrees } = await created();
    store.dispatch({
      type: "tab/provisioningChanged",
      tabId: "t1",
      provisioning: [
        { path: "dist", strategy: "clone" },
        { path: "node_modules", strategy: "skip" },
      ],
    });
    await worktrees.create("t1", "dev", "new");
    await settle();

    expect(provisioning.calls[0].paths).toEqual(["dist"]);
  });

  it("prepares nothing when the project's own list is empty, whatever the default says", async () => {
    const { store, provisioning, worktrees } = await created();
    store.dispatch({ type: "tab/provisioningChanged", tabId: "t1", provisioning: [] });
    await worktrees.create("t1", "dev", "new");
    await settle();

    expect(provisioning.calls).toHaveLength(0);
  });

  it("copies the project's list onto the worktree tab, even without inheriting", async () => {
    const { store, worktrees } = await created();
    store.dispatch({
      type: "settings/changed",
      patch: {
        worktrees: {
          ...store.getState().settings.worktrees,
          inheritFromSourceTab: false,
        },
      },
    });
    const own = [{ path: "dist", strategy: "clone" as const }];
    store.dispatch({ type: "tab/provisioningChanged", tabId: "t1", provisioning: own });
    await worktrees.create("t1", "dev", "new");
    await settle();

    expect(store.getState().tabs[1].project.provisioningOverride).toEqual(own);
  });

  it("marks the tab while it works and clears it after", async () => {
    const { store, provisioning, worktrees } = await created();
    const finish = provisioning.hold();

    await worktrees.create("t1", "dev", "new");
    await settle();
    expect(store.getState().tabs[1].preparing).toBe(true);

    finish();
    await settle();
    expect(store.getState().tabs[1].preparing).toBe(false);
    expect(store.getState().tabs[1].preparingProblem).toBeUndefined();
  });
});

describe("provisionProblem", () => {
  const entry = (path: string, outcome: string, message = "") => ({
    path,
    strategy: "clone" as const,
    outcome,
    message,
  });

  it("says nothing when everything landed", () => {
    const report = {
      worktreePath: "/w",
      entries: [entry("node_modules", "copied")],
      ok: true,
    };
    expect(provisionProblem(report)).toBeUndefined();
  });

  it("says nothing about a folder the main checkout never had", () => {
    const report = {
      worktreePath: "/w",
      entries: [entry("node_modules", "skipped", "The main checkout has no it.")],
      ok: true,
    };
    expect(provisionProblem(report)).toBeUndefined();
  });

  it("names the folder and the reason for a single failure", () => {
    const report = {
      worktreePath: "/w",
      entries: [entry("node_modules", "failed", "Permission denied")],
      ok: false,
    };
    expect(provisionProblem(report)).toBe(
      "Could not prepare node_modules: Permission denied",
    );
  });

  it("counts them when more than one failed", () => {
    const report = {
      worktreePath: "/w",
      entries: [
        entry("node_modules", "failed", "Permission denied"),
        entry("target", "failed", "No space"),
        entry("dist", "copied"),
      ],
      ok: false,
    };
    const problem = provisionProblem(report);
    expect(problem).toContain("2 folders");
    expect(problem).toContain("node_modules");
    expect(problem).toContain("target");
    expect(problem).not.toContain("dist");
  });
});

describe("RemoveWorktree", () => {
  function removal() {
    const { store, git, provisioning, worktrees } = setup();
    const closed: string[] = [];
    const closeProject = {
      execute: async (tabId: string) => {
        closed.push(tabId);
        store.dispatch({ type: "tab/closed", tabId });
      },
    } as unknown as CloseProject;
    const remove = new RemoveWorktree(store, git, provisioning, closeProject);
    git.worktreeList = [
      worktree({ path: "C:/repos/app", main: true, branch: "main" }),
      worktree({ path: "C:/repos/app-worktrees/dev", branch: "dev" }),
    ];
    store.dispatch({
      type: "tab/opened",
      project: newProject("t2", "C:/repos/app-worktrees/dev", DEFAULTS, "C:/repos/app"),
    });
    return { store, git, provisioning, remove, closed, worktrees };
  }

  it("closes the tab before the folder goes", async () => {
    const { git, remove, closed, store } = removal();
    const result = await remove.execute("t2", "C:/repos/app-worktrees/dev", "safe");

    expect(result.ok).toBe(true);
    expect(closed).toEqual(["t2"]);
    expect(git.removed).toEqual([{ path: "C:/repos/app-worktrees/dev", mode: "safe" }]);
    expect(store.getState().tabs).toHaveLength(1);
  });

  it("takes the links back before git recurses into the folder", async () => {
    const { provisioning, remove } = removal();
    const order: string[] = [];
    const original = provisioning.unprovision.bind(provisioning);
    provisioning.unprovision = async (p, paths) => {
      order.push("unprovision");
      return original(p, paths);
    };
    await remove.execute("t2", "C:/repos/app-worktrees/dev", "safe");
    expect(order).toEqual(["unprovision"]);
  });

  it("takes back the list the worktree was stocked with, not today's default", async () => {
    const { store, provisioning, remove } = removal();
    store.dispatch({
      type: "tab/provisioningChanged",
      tabId: "t2",
      provisioning: [{ path: "dist", strategy: "share" }],
    });
    // The default changed since — irrelevant to what this worktree holds.
    store.dispatch({
      type: "settings/changed",
      patch: {
        worktrees: {
          ...defaultSettings.worktrees,
          provisioning: [{ path: "node_modules", strategy: "clone" }],
        },
      },
    });
    await remove.execute("t2", "C:/repos/app-worktrees/dev", "safe");

    expect(provisioning.unprovisioned).toEqual([
      { path: "C:/repos/app-worktrees/dev", paths: ["dist"] },
    ]);
  });

  it("falls back to the acting tab's list when the worktree has no tab", async () => {
    const { store, provisioning, remove } = removal();
    store.dispatch({ type: "tab/closed", tabId: "t2" });
    store.dispatch({
      type: "tab/provisioningChanged",
      tabId: "t1",
      provisioning: [{ path: "dist", strategy: "clone" }],
    });
    await remove.execute("t1", "C:/repos/app-worktrees/dev", "safe");

    expect(provisioning.unprovisioned[0].paths).toEqual(["dist"]);
  });

  it("prunes the leftover bookkeeping once the folder is gone", async () => {
    const { git, remove } = removal();
    await remove.execute("t2", "C:/repos/app-worktrees/dev", "safe");
    expect(git.pruned).toBe(1);
  });

  it("refuses the main checkout outright", async () => {
    const { git, remove } = removal();
    const result = await remove.execute("t1", "C:/repos/app", "safe");
    expect(result.ok).toBe(false);
    expect(result.message).toContain("main checkout");
    expect(git.removed).toHaveLength(0);
  });

  it("reports git's refusal without leaving the tab open", async () => {
    const { git, remove, store } = removal();
    git.failRemoveWith = "fatal: contains modified or untracked files";
    const result = await remove.execute("t2", "C:/repos/app-worktrees/dev", "safe");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("untracked files");
    // The session was already torn down; reopening the folder recovers.
    expect(store.getState().tabs).toHaveLength(1);
  });

  it("passes force through when the caller asked for it", async () => {
    const { git, remove } = removal();
    await remove.execute("t2", "C:/repos/app-worktrees/dev", "force");
    expect(git.removed[0].mode).toBe("force");
  });
});

describe("RemoveWorktree.check", () => {
  function checking() {
    const { store, git, provisioning } = setup();
    const closeProject = { execute: async () => {} } as unknown as CloseProject;
    const remove = new RemoveWorktree(store, git, provisioning, closeProject);
    git.worktreeList = [
      worktree({ path: "C:/repos/app", main: true, branch: "main" }),
      worktree({ path: "C:/repos/app-worktrees/dev", branch: "dev" }),
    ];
    return { git, remove };
  }

  it("calls a merged, clean worktree free to reclaim", async () => {
    const { git, remove } = checking();
    git.mergedBranches = ["dev"];
    const check = await remove.check("t1", "C:/repos/app-worktrees/dev");
    expect(check.reclaimable).toBe(true);
    expect(check.needsForce).toBe(false);
    expect(check.blockers).toEqual([]);
  });

  it("asks for force when the worktree still holds work", async () => {
    const { git, remove } = checking();
    git.mergedBranches = ["dev"];
    git.changedFiles = 2;
    const check = await remove.check("t1", "C:/repos/app-worktrees/dev");
    expect(check.needsForce).toBe(true);
    expect(check.reclaimable).toBe(false);
    expect(check.blockers[0]).toContain("2 uncommitted");
  });

  it("will not call an unmerged branch reclaimable", async () => {
    const { git, remove } = checking();
    git.mergedBranches = ["something-else"];
    const check = await remove.check("t1", "C:/repos/app-worktrees/dev");
    expect(check.reclaimable).toBe(false);
    expect(check.blockers).toEqual([]); // nothing stops it; it is just not free
  });

  it("blocks a path this repository does not own", async () => {
    const { remove } = checking();
    const check = await remove.check("t1", "C:/elsewhere/other");
    expect(check.blockers[0]).toContain("Not a worktree");
  });
});

describe("detectWorktreeOf", () => {
  it("names the main checkout for a linked worktree", async () => {
    const git = new FakeGit();
    git.worktreeList = [
      worktree({ path: "C:/repos/app", main: true }),
      worktree({ path: "C:/repos/app-worktrees/dev", branch: "dev" }),
    ];
    expect(await detectWorktreeOf(git, "C:\\repos\\app-worktrees\\dev")).toBe(
      "C:/repos/app",
    );
  });

  it("stays quiet for the main checkout and for non-repositories", async () => {
    const git = new FakeGit();
    git.worktreeList = [worktree({ path: "C:/repos/app", main: true })];
    expect(await detectWorktreeOf(git, "C:/repos/app")).toBeUndefined();
    git.notARepo = true;
    expect(await detectWorktreeOf(git, "C:/repos/app")).toBeUndefined();
  });
});
