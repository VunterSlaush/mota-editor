import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { AgentGateway } from "../ports/agentGateway";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import type { WorktreeProvisioning } from "../ports/worktreeProvisioning";
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

class FakeFolders {
  folders: string[] = ["apps/web", "apps/api", "docs"];
  async folderCandidates(): Promise<string[]> {
    return this.folders;
  }
}

class FakeSuggestions {
  /** What the agent "answers"; an Error here is a failed run. */
  answer: { name: string; boundaries: string[] }[] | Error = [
    { name: "Frontend", boundaries: ["apps/web"] },
  ];
  calls = 0;
  async suggest(): Promise<{ name: string; boundaries: string[] }[]> {
    this.calls += 1;
    if (this.answer instanceof Error) throw this.answer;
    return this.answer;
  }
}

function harness() {
  const store = new Store();
  const workspaceStore = new FakeWorkspaceStore();
  const gateway = new FakeAgentGateway();
  const folders = new FakeFolders();
  const suggestions = new FakeSuggestions();
  let n = 0;
  const subtasks = new Subtasks(
    store,
    workspaceStore,
    gateway as unknown as AgentGateway,
    () => `id-${++n}`,
    folders as unknown as WorktreeProvisioning,
    suggestions,
  );
  store.dispatch({
    type: "tab/opened",
    project: newProject("t1", "/work/alpha", projectDefaults(defaultSettings)),
  });
  return { store, workspaceStore, gateway, folders, suggestions, subtasks };
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

describe("Subtasks.savePresets", () => {
  it("saves the project's named areas and persists them", async () => {
    const { store, workspaceStore, subtasks } = harness();

    const problem = await subtasks.savePresets("t1", [
      { id: "p1", name: "  Frontend ", boundaries: ["apps/web/"] },
    ]);

    expect(problem).toBeUndefined();
    expect(store.getState().tabs[0].project.boundaryPresets).toEqual([
      { id: "p1", name: "Frontend", boundaries: ["apps/web"] },
    ]);
    expect(workspaceStore.saved?.projects[0].boundaryPresets).toHaveLength(1);
  });

  it("shares the areas with every tab on the same folder", async () => {
    // They describe the repository, not the tab that happened to be
    // open when they were written.
    const { store, subtasks } = harness();
    await subtasks.open("t1", { access: "read-only" });

    await subtasks.savePresets("t1", [
      { id: "p1", name: "Frontend", boundaries: ["apps/web"] },
    ]);

    expect(store.getState().tabs[1].project.boundaryPresets).toHaveLength(1);
  });

  it("clearing removes the field rather than storing an empty list", async () => {
    const { store, subtasks } = harness();
    await subtasks.savePresets("t1", [
      { id: "p1", name: "Frontend", boundaries: ["apps/web"] },
    ]);

    await subtasks.savePresets("t1", []);

    expect("boundaryPresets" in store.getState().tabs[0].project).toBe(false);
  });

  it("refuses a preset that is unnamed or names nothing usable", async () => {
    const { store, subtasks } = harness();

    expect(
      await subtasks.savePresets("t1", [
        { id: "p1", name: "", boundaries: ["apps/web"] },
      ]),
    ).toBeDefined();
    expect(
      await subtasks.savePresets("t1", [
        { id: "p1", name: "Bad", boundaries: ["../out"] },
      ]),
    ).toBeDefined();
    expect(store.getState().tabs[0].project.boundaryPresets).toBeUndefined();
  });
});

describe("Subtasks.suggestPresets", () => {
  it("returns named presets built from what the agent answered", async () => {
    const { subtasks, folders, suggestions } = harness();
    suggestions.answer = [
      { name: "Frontend", boundaries: ["apps/web"] },
      { name: "API", boundaries: ["apps/api"] },
    ];

    const result = await subtasks.suggestPresets("t1");

    expect(result.problem).toBeUndefined();
    expect(result.presets.map((p) => p.name)).toEqual(["Frontend", "API"]);
    // Each one gets an id of ours — the agent does not mint those.
    expect(new Set(result.presets.map((p) => p.id)).size).toBe(2);
    expect(folders.folders.length).toBeGreaterThan(0);
  });

  it("does not save anything — a suggestion is a draft", async () => {
    const { store, subtasks } = harness();

    await subtasks.suggestPresets("t1");

    expect(store.getState().tabs[0].project.boundaryPresets).toBeUndefined();
  });

  it("drops suggestions that name nothing usable", async () => {
    const { subtasks, suggestions } = harness();
    suggestions.answer = [
      { name: "Escape", boundaries: ["../etc"] },
      { name: "Good", boundaries: ["apps/web"] },
    ];

    const result = await subtasks.suggestPresets("t1");

    expect(result.presets.map((p) => p.name)).toEqual(["Good"]);
  });

  it("reports the failure instead of throwing at the caller", async () => {
    const { subtasks, suggestions } = harness();
    suggestions.answer = new Error("claude is not available: not installed");

    const result = await subtasks.suggestPresets("t1");

    expect(result.presets).toEqual([]);
    expect(result.problem).toContain("not available");
  });

  it("says so when the agent answered with nothing usable at all", async () => {
    const { subtasks, suggestions } = harness();
    suggestions.answer = [];

    const result = await subtasks.suggestPresets("t1");

    expect(result.problem).toBeDefined();
  });
});
