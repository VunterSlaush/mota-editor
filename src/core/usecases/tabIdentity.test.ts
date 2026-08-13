import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { defaultSettings, projectDefaults, tabById } from "../state/appState";
import { Store } from "../state/store";
import { RecolorTab, RenameTab } from "./tabIdentity";

class FakeWorkspaceStore implements WorkspaceStore {
  saves = 0;
  saved: PersistedWorkspace | null = null;
  async load() {
    return this.saved;
  }
  async save(workspace: PersistedWorkspace) {
    this.saves += 1;
    this.saved = workspace;
  }
}

const DEFAULTS = projectDefaults(defaultSettings);

function setup() {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", DEFAULTS),
  });
  const workspace = new FakeWorkspaceStore();
  return {
    store,
    workspace,
    renameTab: new RenameTab(store, workspace),
    recolorTab: new RecolorTab(store, workspace),
  };
}

describe("RenameTab", () => {
  it("names a tab and saves the workspace once", async () => {
    const { store, workspace, renameTab } = setup();
    await renameTab.execute("t1", "auth rewrite");

    expect(tabById(store.getState(), "t1")?.project.label).toBe("auth rewrite");
    // Once, not once per character: a save serialises all of it to disk.
    expect(workspace.saves).toBe(1);
  });

  it("an empty name gives the tab back to its folder", async () => {
    const { store, renameTab } = setup();
    await renameTab.execute("t1", "auth rewrite");
    await renameTab.execute("t1", "");

    expect(tabById(store.getState(), "t1")?.project.label).toBeUndefined();
  });
});

describe("RecolorTab", () => {
  it("colours a tab and saves the workspace once", async () => {
    const { store, workspace, recolorTab } = setup();
    await recolorTab.execute("t1", "teal");

    expect(tabById(store.getState(), "t1")?.project.color).toBe("teal");
    expect(workspace.saves).toBe(1);
  });

  it("takes a colour away again", async () => {
    const { store, recolorTab } = setup();
    await recolorTab.execute("t1", "teal");
    await recolorTab.execute("t1", undefined);

    expect(tabById(store.getState(), "t1")?.project.color).toBeUndefined();
  });
});
