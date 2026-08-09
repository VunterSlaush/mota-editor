import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { GitPort } from "../ports/gitPort";
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

const setup = (git: FakeGit) => {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", projectDefaults(defaultSettings)),
  });
  return new ListProjectFiles(store, git as unknown as GitPort);
};

describe("ListProjectFiles", () => {
  it("lists the files in the tab's project folder", async () => {
    const git = new FakeGit();
    expect(await setup(git).execute("t1")).toEqual(["README.md", "src/main.ts"]);
    expect(git.asked).toBe("/work/alpha");
  });

  it("returns nothing for an unknown tab", async () => {
    const git = new FakeGit();
    expect(await setup(git).execute("nope")).toEqual([]);
    expect(git.asked).toBeNull();
  });

  it("returns nothing when the folder is not a git repository", async () => {
    const git = new FakeGit();
    git.failWith = "not a git repository";
    expect(await setup(git).execute("t1")).toEqual([]);
  });
});
