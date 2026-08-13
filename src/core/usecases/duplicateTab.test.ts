import { describe, expect, it } from "vitest";
import { newProject } from "../entities/project";
import type { AgentGateway } from "../ports/agentGateway";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { DuplicateTab } from "./duplicateTab";

const DEFAULTS = projectDefaults(defaultSettings);

class FakeWorkspaceStore implements WorkspaceStore {
  saved: PersistedWorkspace | null = null;
  async load() {
    return this.saved;
  }
  async save(workspace: PersistedWorkspace) {
    this.saved = workspace;
  }
}

interface Warmed {
  tabId: string;
  provider: string;
  path: string;
  model?: string;
  effort?: string;
}

class FakeAgentGateway {
  warmed: Warmed[] = [];
  async warmSession(
    tabId: string,
    provider: string,
    path: string,
    model?: string,
    effort?: string,
  ): Promise<void> {
    this.warmed.push({ tabId, provider, path, model, effort });
  }
}

function withOneTab() {
  const store = new Store();
  store.dispatch({
    type: "tab/opened",
    project: {
      ...newProject("t1", "/work/alpha", DEFAULTS),
      provider: "codex",
      model: "gpt-5.5",
      effort: "high",
      label: "auth rewrite",
    },
  });
  const workspaceStore = new FakeWorkspaceStore();
  const agentGateway = new FakeAgentGateway();
  const duplicateTab = new DuplicateTab(
    store,
    workspaceStore,
    agentGateway as unknown as AgentGateway,
    () => "t2",
  );
  return { store, workspaceStore, agentGateway, duplicateTab };
}

describe("DuplicateTab", () => {
  it("opens a second tab on the same folder and makes it the active one", async () => {
    const { store, duplicateTab } = withOneTab();

    await duplicateTab.execute("t1");

    const state = store.getState();
    expect(state.tabs).toHaveLength(2);
    expect(state.tabs[1].project.path).toBe("/work/alpha");
    expect(state.activeTabId).toBe("t2");
  });

  it("warms the copy's own session with the setup it inherited", async () => {
    // Without this the second tab pays the whole agent handshake on its
    // first message, which is the cost warming exists to remove.
    const { agentGateway, duplicateTab } = withOneTab();

    await duplicateTab.execute("t1");

    expect(agentGateway.warmed).toEqual([
      {
        tabId: "t2",
        provider: "codex",
        path: "/work/alpha",
        model: "gpt-5.5",
        effort: "high",
      },
    ]);
  });

  it("saves the workspace, so the copy survives a restart", async () => {
    const { workspaceStore, duplicateTab } = withOneTab();

    await duplicateTab.execute("t1");

    expect(workspaceStore.saved?.projects.map((p) => p.id)).toEqual(["t1", "t2"]);
    expect(workspaceStore.saved?.activeTabId).toBe("t2");
  });

  it("does nothing at all for a tab that is no longer open", async () => {
    const { store, workspaceStore, agentGateway, duplicateTab } = withOneTab();

    await duplicateTab.execute("gone");

    expect(store.getState().tabs).toHaveLength(1);
    expect(agentGateway.warmed).toEqual([]);
    expect(workspaceStore.saved).toBeNull();
  });
});
