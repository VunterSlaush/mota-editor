import { describe, expect, it } from "vitest";
import type { AgentGateway } from "../ports/agentGateway";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { type AppSettings, defaultSettings } from "../state/appState";
import { Store } from "../state/store";
import { toPersisted } from "./persistWorkspace";
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

/** Every setting moved off its default, so a dropped field is visible. */
const CUSTOM_SETTINGS: AppSettings = {
  defaultProvider: "codex",
  defaultMode: "plan",
  defaultPermission: "bypass",
  defaultModel: { claude: "opus", codex: "gpt-5.5" },
  defaultEffort: { claude: "high" },
  commandConfigs: { "claude:/review": { mode: "plan", model: "haiku" } },
  mcpServers: [
    {
      id: "s1",
      name: "files",
      command: "npx",
      args: ["-y", "server"],
      env: { ROOT: "/work" },
      enabledFor: ["claude"],
    },
  ],
  autoCompactThreshold: 0.6,
  autoCompact: "ask",
  zoomLevel: 2,
  worktrees: {
    ...defaultSettings.worktrees,
    remote: "upstream",
    inheritFromSourceTab: !defaultSettings.worktrees.inheritFromSourceTab,
  },
  theme: "mota-light",
  terminalShell: "/bin/zsh",
  terminalFontSize: 15,
  terminalSuggestions: false,
};

/**
 * `restoredSettings` names every field instead of spreading, so a
 * setting added later is only defaulted if someone remembered to add a
 * line. These are the tests that notice when nobody did.
 */
describe("RestoreWorkspace settings", () => {
  it("brings every setting back exactly as it was saved", async () => {
    // The whole-object guard: a new AppSettings field that persists but
    // has no `??` line saves fine and silently reverts on next launch.
    // Comparing the WHOLE object covers any future field for free.
    const store = new Store();
    store.dispatch({
      type: "workspace/restored",
      tabs: [],
      activeTabId: null,
      settings: CUSTOM_SETTINGS,
    });

    const state = await restore(toPersisted(store.getState()));
    expect(state.settings).toEqual(CUSTOM_SETTINGS);
  });

  it("defaults every setting for a file written before they existed", async () => {
    const state = await restore(EMPTY);
    expect(state.settings).toEqual(defaultSettings);
  });

  it("defaults a single missing setting, keeping the ones that are there", async () => {
    // An older build's file has no autoCompact at all.
    const { autoCompact: _, ...older } = CUSTOM_SETTINGS;

    const state = await restore({ ...EMPTY, settings: older });

    expect(state.settings.autoCompact).toBe(defaultSettings.autoCompact);
    expect(state.settings.theme).toBe(CUSTOM_SETTINGS.theme);
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

  it("keeps the provisioning list the file carries", async () => {
    const provisioning = [{ path: "node_modules", strategy: "clone" as const }];
    const state = await restore({
      ...EMPTY,
      settings: { worktrees: { provisioning } },
    });
    expect(state.settings.worktrees.provisioning).toEqual(provisioning);
  });

  it("leaves the state alone when there is no workspace file at all", async () => {
    const state = await restore(null);
    expect(state.settings).toEqual(defaultSettings);
    expect(state.tabs).toEqual([]);
  });
});

describe("RestoreWorkspace projects", () => {
  it("brings a project's per-project MCP overrides back", async () => {
    const state = await restore({
      projects: [
        {
          id: "t1",
          path: "/work/alpha",
          provider: "claude",
          providerSessions: {},
          mcpOverrides: { s1: false, s2: true },
        },
      ],
      activeTabId: "t1",
    });

    expect(state.tabs[0].project.mcpOverrides).toEqual({ s1: false, s2: true });
  });

  it("brings back a CLAIM on the transcript the tab was writing to", async () => {
    const state = await restore({
      projects: [
        {
          id: "t1",
          path: "/work/alpha",
          provider: "claude",
          providerSessions: { claude: "claude-abc" },
          historySessionId: "old-1",
        },
      ],
      activeTabId: "t1",
    });

    // A claim, not the live id: the messages are gone from the screen,
    // so it is adopted only once the agent proves to be in that same
    // conversation. Until then the tab is on no transcript at all.
    expect(state.tabs[0].restoredHistorySessionId).toBe("old-1");
    expect(state.tabs[0].historySessionId).toBeUndefined();
  });

  it("persists that claim again, so a second restart does not lose it", async () => {
    const state = await restore({
      projects: [
        {
          id: "t1",
          path: "/work/alpha",
          provider: "claude",
          providerSessions: {},
          historySessionId: "old-1",
        },
      ],
      activeTabId: "t1",
    });

    // Restarted twice without ever sending a prompt: the claim is still
    // the only thing pointing at that conversation.
    expect(toPersisted(state).projects[0].historySessionId).toBe("old-1");
  });

  it("brings a project's own provisioning list back, and it survives a round-trip", async () => {
    const provisioningOverride = [{ path: "dist", strategy: "share" as const }];
    const state = await restore({
      projects: [
        {
          id: "t1",
          path: "/work/alpha-worktrees/dev",
          provider: "claude",
          providerSessions: {},
          provisioningOverride,
          worktreeOf: "/work/alpha",
        },
      ],
      activeTabId: "t1",
    });

    expect(state.tabs[0].project.provisioningOverride).toEqual(provisioningOverride);
    // Persisting what was restored keeps the list — a worktree removed in
    // a later session must still know what it was stocked with.
    expect(toPersisted(state).projects[0].provisioningOverride).toEqual(
      provisioningOverride,
    );
  });
});
