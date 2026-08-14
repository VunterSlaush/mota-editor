import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { AgentGateway } from "../ports/agentGateway";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { Subtasks } from "./subtasks";

class FakeWorkspaceStore implements WorkspaceStore {
  saved: PersistedWorkspace | null = null;
  async load() {
    return null;
  }
  async save(workspace: PersistedWorkspace) {
    this.saved = workspace;
  }
}

class FakeAgentGateway {
  warmed: string[] = [];
  async warmSession(tabId: string): Promise<void> {
    this.warmed.push(tabId);
  }
}

function harness() {
  const store = new Store();
  const workspaceStore = new FakeWorkspaceStore();
  const gateway = new FakeAgentGateway();
  let n = 0;
  const subtasks = new Subtasks(
    store,
    workspaceStore,
    gateway as unknown as AgentGateway,
    () => `id-${++n}`,
  );
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", projectDefaults(defaultSettings)),
  });
  return { store, workspaceStore, gateway, subtasks };
}

describe("Subtasks.open", () => {
  it("opens a scoped tab on the source tab's folder and warms it", async () => {
    const { store, gateway, subtasks } = harness();

    const problem = await subtasks.open("t1", { access: "read-only" });

    expect(problem).toBeUndefined();
    const tabs = store.getState().tabs;
    expect(tabs).toHaveLength(2);
    expect(tabs[1].project.path).toBe("/work/alpha");
    expect(tabs[1].project.subtask).toEqual({ access: "read-only" });
    expect(store.getState().activeTabId).toBe(tabs[1].project.id);
    expect(gateway.warmed).toEqual([tabs[1].project.id]);
  });

  it("seeds the new tab from the source tab, but never its scope-free authority", async () => {
    const { store, subtasks } = harness();
    store.dispatch({ type: "tab/modeChanged", tabId: "t1", mode: "debug" });

    await subtasks.open("t1", { access: "boundary", boundaries: ["apps/web/"] });

    const tab = store.getState().tabs[1];
    expect(tab.project.mode).toBe("debug");
    expect(tab.project.subtask).toEqual({ access: "boundary", boundaries: ["apps/web"] });
  });

  it("persists the workspace with the new subtask in it", async () => {
    const { workspaceStore, subtasks } = harness();

    await subtasks.open("t1", { access: "read-only" });

    expect(workspaceStore.saved?.projects).toHaveLength(2);
    expect(workspaceStore.saved?.projects[1].subtask).toEqual({ access: "read-only" });
  });

  it("refuses a boundary scope with no usable folder", async () => {
    const { store, subtasks } = harness();

    const problem = await subtasks.open("t1", { access: "boundary", boundaries: [] });

    expect(problem).toBeDefined();
    expect(store.getState().tabs).toHaveLength(1);
  });

  it("refuses an unknown source tab", async () => {
    const { subtasks } = harness();
    expect(await subtasks.open("nope", { access: "read-only" })).toBeDefined();
  });
});

describe("Subtasks.changeScope", () => {
  it("re-scopes the tab and warms its session so the agent respawns", async () => {
    const { store, gateway, subtasks } = harness();
    await subtasks.open("t1", { access: "read-only" });
    const tabId = store.getState().tabs[1].project.id;
    gateway.warmed = [];

    const problem = await subtasks.changeScope(tabId, {
      access: "boundary",
      boundaries: ["apps/web"],
    });

    expect(problem).toBeUndefined();
    expect(store.getState().tabs[1].project.subtask).toEqual({
      access: "boundary",
      boundaries: ["apps/web"],
    });
    expect(gateway.warmed).toEqual([tabId]);
  });

  it("does nothing when the scope is unchanged in substance", async () => {
    const { store, gateway, subtasks } = harness();
    await subtasks.open("t1", { access: "boundary", boundaries: ["apps/web"] });
    const tabId = store.getState().tabs[1].project.id;
    gateway.warmed = [];

    // Same folder, different spelling: no respawn for a non-change.
    await subtasks.changeScope(tabId, {
      access: "boundary",
      boundaries: ["apps\\web\\"],
    });

    expect(gateway.warmed).toEqual([]);
  });

  it("refuses to scope a plain tab", async () => {
    const { store, subtasks } = harness();

    const problem = await subtasks.changeScope("t1", { access: "read-only" });

    expect(problem).toBeDefined();
    expect(store.getState().tabs[0].project.subtask).toBeUndefined();
  });
});
