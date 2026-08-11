import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { ScopeWorktreeProvisioning } from "./scopeWorktreeProvisioning";

class FakeWorkspaceStore implements WorkspaceStore {
  saved: PersistedWorkspace | null = null;
  async load() {
    return this.saved;
  }
  async save(workspace: PersistedWorkspace) {
    this.saved = workspace;
  }
}

function setup() {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", projectDefaults(defaultSettings)),
  });
  const workspace = new FakeWorkspaceStore();
  return { store, workspace, scope: new ScopeWorktreeProvisioning(store, workspace) };
}

describe("ScopeWorktreeProvisioning", () => {
  it("records the project's own list and persists it", async () => {
    const { store, workspace, scope } = setup();
    const own = [{ path: "dist", strategy: "clone" as const }];
    await scope.execute("t1", own);

    expect(store.getState().tabs[0].project.provisioningOverride).toEqual(own);
    expect(workspace.saved?.projects[0].provisioningOverride).toEqual(own);
  });

  it("clearing persists a project without the field", async () => {
    const { store, workspace, scope } = setup();
    await scope.execute("t1", [{ path: "dist", strategy: "clone" }]);
    await scope.execute("t1", undefined);

    expect("provisioningOverride" in store.getState().tabs[0].project).toBe(false);
    expect(workspace.saved?.projects[0].provisioningOverride).toBeUndefined();
  });

  it("does nothing for an unknown tab", async () => {
    const { workspace, scope } = setup();
    await scope.execute("nope", []);
    expect(workspace.saved).toBeNull();
  });
});
