import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { GitPort } from "../ports/gitPort";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { LoadBranches } from "./loadBranches";

const DEFAULTS = projectDefaults(defaultSettings);

/** Answers per project path; a path it does not know throws, the way
 *  git does for a folder that is not a repository. */
class FakeGit implements Partial<GitPort> {
  asked: string[] = [];
  constructor(private readonly onBranch: Record<string, string>) {}
  async currentBranch(projectPath: string): Promise<string> {
    this.asked.push(projectPath);
    const branch = this.onBranch[projectPath];
    if (branch === undefined) throw new Error("not a git repository");
    return branch;
  }
}

function setup(branches: Record<string, string>) {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", DEFAULTS),
  });
  store.dispatch({
    type: "tab/opened",
    project: newProject("t2", "/work/beta", DEFAULTS),
  });
  const git = new FakeGit(branches);
  return {
    store,
    git,
    loadBranches: new LoadBranches(store, git as unknown as GitPort),
  };
}

const branchOf = (store: Store, tabId: string) =>
  store.getState().tabs.find((t) => t.project.id === tabId)?.branch;

describe("LoadBranches", () => {
  it("learns the branch of every open project, not only the active one", async () => {
    const { store, loadBranches } = setup({
      "/work/alpha": "main",
      "/work/beta": "polish",
    });

    await loadBranches.execute();

    expect(branchOf(store, "t1")).toBe("main");
    expect(branchOf(store, "t2")).toBe("polish");
  });

  it("asks git once per project", async () => {
    const { git, loadBranches } = setup({
      "/work/alpha": "main",
      "/work/beta": "polish",
    });
    await loadBranches.execute();
    expect(git.asked).toEqual(["/work/alpha", "/work/beta"]);
  });

  it("leaves a folder git knows nothing about without a branch", async () => {
    const { store, loadBranches } = setup({ "/work/alpha": "main" });

    await loadBranches.execute();

    expect(branchOf(store, "t1")).toBe("main");
    expect(branchOf(store, "t2")).toBeUndefined();
  });

  it("reads a detached HEAD as no branch rather than an empty one", async () => {
    const { store, loadBranches } = setup({ "/work/alpha": "", "/work/beta": "polish" });
    await loadBranches.execute();
    expect(branchOf(store, "t1")).toBeUndefined();
  });
});
