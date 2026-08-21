import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { GitPort } from "../ports/gitPort";
import type { ProjectFiles } from "../ports/projectFiles";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { ListProjectFiles } from "./listProjectFiles";

class FakeGit {
  paths: string[] = ["README.md", "src/main.ts"];
  failWith: string | null = null;
  asked: string | null = null;

  async listFiles(projectPath: string): Promise<string[]> {
    this.asked = projectPath;
    if (this.failWith) throw new Error(this.failWith);
    return this.paths;
  }
}

class FakeDisk {
  paths: string[] = ["notes.txt"];
  failWith: string | null = null;
  asked: string | null = null;

  async walk(projectPath: string): Promise<string[]> {
    this.asked = projectPath;
    if (this.failWith) throw new Error(this.failWith);
    return this.paths;
  }
}

const setup = (git: FakeGit, disk: FakeDisk = new FakeDisk()) => {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", projectDefaults(defaultSettings)),
  });
  return new ListProjectFiles(
    store,
    git as unknown as GitPort,
    disk as unknown as ProjectFiles,
  );
};

describe("ListProjectFiles", () => {
  it("lists the files in the tab's project folder", async () => {
    const git = new FakeGit();
    expect(await setup(git).execute("t1")).toEqual(["README.md", "src/main.ts"]);
    expect(git.asked).toBe("/work/alpha");
  });

  it("leaves the disk alone while git has an answer", async () => {
    const disk = new FakeDisk();
    await setup(new FakeGit(), disk).execute("t1");
    expect(disk.asked).toBeNull();
  });

  it("returns nothing for an unknown tab", async () => {
    const git = new FakeGit();
    const disk = new FakeDisk();
    expect(await setup(git, disk).execute("nope")).toEqual([]);
    expect(git.asked).toBeNull();
    expect(disk.asked).toBeNull();
  });

  // The panel would otherwise show an empty tree of the user's own files.
  it("reads the disk when the folder is not a git repository", async () => {
    const git = new FakeGit();
    git.failWith = "not a git repository";
    const disk = new FakeDisk();

    expect(await setup(git, disk).execute("t1")).toEqual(["notes.txt"]);
    expect(disk.asked).toBe("/work/alpha");
  });

  it("reads the disk when git knows the folder but lists nothing in it", async () => {
    const git = new FakeGit();
    git.paths = [];

    expect(await setup(git).execute("t1")).toEqual(["notes.txt"]);
  });

  it("returns nothing when neither git nor the disk can answer", async () => {
    const git = new FakeGit();
    git.failWith = "not a git repository";
    const disk = new FakeDisk();
    disk.failWith = "permission denied";

    expect(await setup(git, disk).execute("t1")).toEqual([]);
  });
});
