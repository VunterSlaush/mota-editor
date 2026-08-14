import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type {
  GitBranch,
  GitChange,
  GitCommit,
  GitDivergence,
  GitPort,
  GitWorktree,
  WorktreeAddMode,
} from "../ports/gitPort";
import { defaultSettings, projectDefaults, tabById } from "../state/appState";
import { Store } from "../state/store";
import { GitActions } from "./gitActions";
import { LoadGitChanges } from "./loadGitChanges";

class FakeGit implements GitPort {
  calls: string[] = [];
  files: GitChange[] = [];
  commits: GitCommit[] = [];
  failPushWith: string | null = null;
  notARepo = false;
  remote = "git@github.com:mota/repo.git";
  failRemoteWith: string | null = null;
  divergence: GitDivergence | null = { behind: 0, ahead: 0 };

  async changes(): Promise<GitChange[]> {
    if (this.notARepo) throw new Error("not a repo");
    return this.files;
  }
  async remoteUrl(): Promise<string> {
    if (this.failRemoteWith) throw new Error(this.failRemoteWith);
    return this.remote;
  }
  async upstream(): Promise<GitDivergence | null> {
    return this.divergence;
  }
  async listFiles(): Promise<string[]> {
    return this.files.map((f) => f.path);
  }
  async diff(
    _p: string,
    path: string,
    staged: boolean,
    untracked: boolean,
  ): Promise<string> {
    this.calls.push(`diff:${path}:${staged}:${untracked}`);
    return `@@ -1 +1 @@\n-old\n+new`;
  }
  async log(): Promise<GitCommit[]> {
    return this.commits;
  }
  async branches(): Promise<GitBranch[]> {
    return [
      { name: "main", current: true },
      { name: "dev", current: false },
    ];
  }
  async stage(_p: string, path: string): Promise<void> {
    this.calls.push(`stage:${path}`);
  }
  async unstage(_p: string, path: string): Promise<void> {
    this.calls.push(`unstage:${path}`);
  }
  async stageAll(): Promise<void> {
    this.calls.push("stageAll");
  }
  async unstageAll(): Promise<void> {
    this.calls.push("unstageAll");
  }
  async commit(_p: string, message: string): Promise<string> {
    if (this.failCommitWith) throw new Error(this.failCommitWith);
    this.calls.push(`commit:${message}`);
    return "1 file changed";
  }
  async checkout(_p: string, branch: string): Promise<string> {
    this.calls.push(`checkout:${branch}`);
    return `Switched to branch '${branch}'`;
  }
  failCommitWith: string | null = null;
  /** Holds `push` open, so a test can look at the tab mid-verb. */
  pushPending: Promise<void> | null = null;
  async push(): Promise<string> {
    if (this.pushPending) await this.pushPending;
    if (this.failPushWith) throw new Error(this.failPushWith);
    return "Everything up-to-date";
  }
  async pull(): Promise<string> {
    return "Already up to date.";
  }
  async fetch(): Promise<string> {
    this.calls.push("fetch");
    return "Fetched origin.";
  }
  worktreeList: GitWorktree[] = [];
  failWorktreeAddWith: string | null = null;
  async worktrees(): Promise<GitWorktree[]> {
    if (this.notARepo) throw new Error("not a repo");
    return this.worktreeList;
  }
  async worktreeAdd(
    _p: string,
    worktreePath: string,
    branch: string,
    mode: WorktreeAddMode,
  ): Promise<string> {
    if (this.failWorktreeAddWith) throw new Error(this.failWorktreeAddWith);
    this.calls.push(`worktreeAdd:${worktreePath}:${branch}:${mode}`);
    return "Preparing worktree";
  }
  async worktreeRemove(_p: string, worktreePath: string): Promise<string> {
    this.calls.push(`worktreeRemove:${worktreePath}`);
    return "Removing worktree";
  }
  async worktreePrune(): Promise<string> {
    this.calls.push("worktreePrune");
    return "";
  }
  async branchesMerged(): Promise<GitBranch[]> {
    return [];
  }
  async currentBranch(): Promise<string> {
    return "main";
  }
}

function setup() {
  const store = new Store();
  store.dispatch({ type: "tab/opened", project: newProject("t1", "/repo", DEFAULTS) });
  const git = new FakeGit();
  return {
    store,
    git,
    actions: new GitActions(store, git),
    loader: new LoadGitChanges(store, git),
  };
}

const DEFAULTS = projectDefaults(defaultSettings);

describe("git use cases", () => {
  it("splits changes into staged and unstaged, with commits", async () => {
    const { git, loader } = setup();
    git.files = [
      { path: "a.rs", staged: true, unstaged: false, label: "modified" },
      { path: "b.rs", staged: false, unstaged: true, label: "untracked" },
      { path: "c.rs", staged: true, unstaged: true, label: "modified" },
    ];
    git.commits = [{ hash: "abc", subject: "Init", author: "m", when: "now" }];

    const result = await loader.execute("t1");

    expect(result?.staged.map((f) => f.path)).toEqual(["a.rs", "c.rs"]);
    expect(result?.unstaged.map((f) => f.path)).toEqual(["b.rs", "c.rs"]);
    expect(result?.commits).toHaveLength(1);
  });

  it("carries the commits waiting to be pulled and pushed", async () => {
    const { git, loader } = setup();
    git.divergence = { behind: 3, ahead: 1 };
    expect((await loader.execute("t1"))?.divergence).toEqual({ behind: 3, ahead: 1 });
  });

  it("a branch tracking nothing loads without a divergence", async () => {
    const { git, loader } = setup();
    git.divergence = null;
    expect((await loader.execute("t1"))?.divergence).toBeNull();
  });

  it("returns null for folders that are not repositories", async () => {
    const { git, loader } = setup();
    git.notARepo = true;
    expect(await loader.execute("t1")).toBeNull();
  });

  it("stages and unstages through the port", async () => {
    const { git, actions } = setup();
    await actions.stage("t1", "a.rs");
    await actions.unstage("t1", "b.rs");
    expect(git.calls).toEqual(["stage:a.rs", "unstage:b.rs"]);
  });

  it("stages and unstages everything in one call, not one per file", async () => {
    const { git, actions } = setup();
    await actions.stageAll("t1");
    await actions.unstageAll("t1");
    expect(git.calls).toEqual(["stageAll", "unstageAll"]);
  });

  it("the verb in flight is on the tab, so leaving the panel keeps it", async () => {
    const { store, git, actions } = setup();
    let finishPush = () => {};
    git.pushPending = new Promise<void>((resolve) => {
      finishPush = resolve;
    });

    const pushing = actions.push("t1");
    expect(tabById(store.getState(), "t1")?.gitVerb).toBe("push");

    finishPush();
    await pushing;

    const tab = tabById(store.getState(), "t1");
    expect(tab?.gitVerb).toBeUndefined();
    expect(tab?.gitNotice).toEqual({ ok: true, message: "Everything up-to-date" });
  });

  it("a verb that says nothing leaves no notice behind", async () => {
    const { store, actions } = setup();
    await actions.pull("t1");
    await actions.stage("t1", "a.rs");
    expect(tabById(store.getState(), "t1")?.gitNotice).toBeUndefined();
  });

  it("push errors come back as messages, not exceptions", async () => {
    const { git, actions } = setup();
    git.failPushWith = "remote: authentication required";

    const result = await actions.push("t1");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("authentication");
  });

  it("pull reports its summary", async () => {
    const { actions } = setup();
    const result = await actions.pull("t1");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Already up to date.");
  });

  it("commit & push commits first, then pushes", async () => {
    const { git, actions } = setup();

    const result = await actions.commitAndPush("t1", "Add the panel");

    expect(result.ok).toBe(true);
    expect(git.calls).toEqual(["commit:Add the panel"]);
    expect(result.message).toBe("Everything up-to-date"); // push's summary
  });

  it("commit & push stops at a failed commit — nothing is pushed", async () => {
    const { git, actions } = setup();
    git.failCommitWith = "nothing to commit";
    git.failPushWith = "should never be reached";

    const result = await actions.commitAndPush("t1", "msg");

    expect(result.ok).toBe(false);
    expect(result.message).toContain("nothing to commit");
  });

  it("checkout switches branch through the port", async () => {
    const { git, actions } = setup();
    const result = await actions.checkout("t1", "dev");
    expect(result.ok).toBe(true);
    expect(git.calls).toEqual(["checkout:dev"]);
  });

  it("loader includes the branch list", async () => {
    const { loader } = setup();
    const result = await loader.execute("t1");
    expect(result?.branches.map((b) => b.name)).toEqual(["main", "dev"]);
    expect(result?.branches[0].current).toBe(true);
  });

  it("loader includes the remote, and survives a repo without one", async () => {
    const { git, loader } = setup();
    expect((await loader.execute("t1"))?.remote).toBe("git@github.com:mota/repo.git");

    git.failRemoteWith = "no such key";
    const result = await loader.execute("t1");
    expect(result).not.toBeNull(); // a missing remote is not a broken panel
    expect(result?.remote).toBe("");
  });

  it("fetch reports its summary without touching the tree", async () => {
    const { git, actions } = setup();
    const result = await actions.fetch("t1");
    expect(result.ok).toBe(true);
    expect(result.message).toBe("Fetched origin.");
    expect(git.calls).toEqual(["fetch"]);
  });

  it("diff asks the port for the right side of the change", async () => {
    const { git, actions } = setup();

    const staged = await actions.diff("t1", "a.rs", true, false);
    await actions.diff("t1", "new.rs", false, true);

    expect(staged.ok).toBe(true);
    expect(staged.message).toContain("+new");
    expect(git.calls).toEqual(["diff:a.rs:true:false", "diff:new.rs:false:true"]);
  });
});
