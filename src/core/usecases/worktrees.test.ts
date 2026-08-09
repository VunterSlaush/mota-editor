import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { AgentGateway } from "../ports/agentGateway";
import type { GitPort, GitWorktree } from "../ports/gitPort";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { detectWorktreeOf, Worktrees } from "./worktrees";

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
  added: Array<{ path: string; branch: string; mode: string }> = [];

  async worktrees(): Promise<GitWorktree[]> {
    if (this.notARepo) throw new Error("not a repo");
    return this.worktreeList;
  }
  async worktreeAdd(_p: string, path: string, branch: string, mode: string) {
    if (this.failWorktreeAddWith) throw new Error(this.failWorktreeAddWith);
    this.added.push({ path, branch, mode });
    return "Preparing worktree";
  }

  async changes() {
    return [];
  }
  async log() {
    return [];
  }
  async branches() {
    return [];
  }
  async remoteUrl() {
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

function setup() {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "C:\\repos\\app", DEFAULTS),
  });
  const git = new FakeGit();
  const workspace = new FakeWorkspaceStore();
  const gateway = new FakeAgentGateway();
  let counter = 0;
  const worktrees = new Worktrees(
    store,
    git,
    workspace,
    gateway as unknown as AgentGateway,
    () => `id-${++counter}`,
  );
  return { store, git, workspace, gateway, worktrees };
}

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
