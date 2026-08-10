import { describe, expect, it } from "vitest";
import type { AgentGateway } from "../ports/agentGateway";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { defaultSettings } from "../state/appState";
import { Store } from "../state/store";
import { RestoreWorkspace } from "./restoreWorkspace";

class FakeWorkspaceStore implements WorkspaceStore {
  constructor(private readonly workspace: PersistedWorkspace | null) {}
  async load() {
    return this.workspace;
  }
  async save() {}
}

class FakeAgentGateway {
  async warmSession(): Promise<void> {}
}

async function restore(workspace: PersistedWorkspace | null) {
  const store = new Store();
  await new RestoreWorkspace(
    store,
    new FakeWorkspaceStore(workspace),
    new FakeAgentGateway() as unknown as AgentGateway,
  ).execute();
  return store.getState();
}

const EMPTY: PersistedWorkspace = { projects: [], activeTabId: null };

/**
 * `restoredSettings` names every field instead of spreading, so a
 * setting added later is only defaulted if someone remembered to add a
 * line. These are the tests that notice when nobody did.
 */
describe("RestoreWorkspace settings", () => {
  it("defaults every setting for a file written before they existed", async () => {
    const state = await restore(EMPTY);
    expect(state.settings).toEqual(defaultSettings);
  });

  it("defaults the worktree group when the file has no worktree settings", async () => {
    const state = await restore({ ...EMPTY, settings: { theme: "mota-light" } });
    expect(state.settings.theme).toBe("mota-light");
    expect(state.settings.worktrees).toEqual(defaultSettings.worktrees);
  });

  it("defaults worktree fields one by one, keeping the ones that are there", async () => {
    const state = await restore({
      ...EMPTY,
      settings: { worktrees: { remote: "upstream" } },
    });
    expect(state.settings.worktrees.remote).toBe("upstream");
    expect(state.settings.worktrees.container).toBe(defaultSettings.worktrees.container);
    expect(state.settings.worktrees.provisioning).toEqual(
      defaultSettings.worktrees.provisioning,
    );
    expect(state.settings.worktrees.inheritFromSourceTab).toBe(
      defaultSettings.worktrees.inheritFromSourceTab,
    );
  });

  it("keeps an empty provisioning list rather than defaulting it back", async () => {
    const state = await restore({
      ...EMPTY,
      settings: { worktrees: { provisioning: [] } },
    });
    expect(state.settings.worktrees.provisioning).toEqual([]);
  });

  it("leaves the state alone when there is no workspace file at all", async () => {
    const state = await restore(null);
    expect(state.settings).toEqual(defaultSettings);
    expect(state.tabs).toEqual([]);
  });
});
