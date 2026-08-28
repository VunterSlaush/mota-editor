import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { ProjectFiles } from "../ports/projectFiles";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { ListProjectFiles } from "./listProjectFiles";

class FakeDisk {
  paths: string[] = ["README.md", "src/main.ts"];
  failWith: string | null = null;
  asked: string | null = null;

  async walk(projectPath: string): Promise<string[]> {
    this.asked = projectPath;
    if (this.failWith) throw new Error(this.failWith);
    return this.paths;
  }
}

const setup = (disk: FakeDisk) => {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", projectDefaults(defaultSettings)),
  });
  return new ListProjectFiles(store, disk as unknown as ProjectFiles);
};

describe("ListProjectFiles", () => {
  it("lists the files in the tab's project folder", async () => {
    const disk = new FakeDisk();
    expect(await setup(disk).execute("t1")).toEqual(["README.md", "src/main.ts"]);
    expect(disk.asked).toBe("/work/alpha");
  });

  // The whole point of reading the disk: git would have hidden these.
  it("keeps the files a .gitignore would have hidden", async () => {
    const disk = new FakeDisk();
    disk.paths = [".env", "README.md"];

    expect(await setup(disk).execute("t1")).toEqual([".env", "README.md"]);
  });

  it("returns nothing for an unknown tab", async () => {
    const disk = new FakeDisk();
    expect(await setup(disk).execute("nope")).toEqual([]);
    expect(disk.asked).toBeNull();
  });

  it("returns nothing when the folder cannot be read", async () => {
    const disk = new FakeDisk();
    disk.failWith = "permission denied";

    expect(await setup(disk).execute("t1")).toEqual([]);
  });
});
