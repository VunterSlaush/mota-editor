import { describe, expect, it } from "vitest";
import type { AgentGateway } from "../ports/agentGateway";
import type { PersistedWorkspace, WorkspaceStore } from "../ports/workspacePort";
import { type AppSettings, defaultSettings } from "../state/appState";
import { Store } from "../state/store";
import { toPersisted } from "./persistWorkspace";
import { RestoreWorkspace } from "./restoreWorkspace";

class FakeWorkspaceStore implements WorkspaceStore {
  constructor(public saved: PersistedWorkspace | null = null) {}
  async load() {
    return this.saved;
  }
  async save(workspace: PersistedWorkspace) {
    this.saved = workspace;
  }
}

class FakeAgentGateway implements Partial<AgentGateway> {
  async warmSession(): Promise<void> {}
}

const gateway = new FakeAgentGateway() as unknown as AgentGateway;

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
  theme: "mota-light",
};

async function restored(persisted: PersistedWorkspace): Promise<AppSettings> {
  const store = new Store();
  await new RestoreWorkspace(store, new FakeWorkspaceStore(persisted), gateway).execute();
  return store.getState().settings;
}

describe("workspace settings round trip", () => {
  it("brings every setting back exactly as it was saved", async () => {
    // The guard against the classic bug: a new AppSettings field that is
    // persisted but has no `??` line in restoredSettings saves fine and
    // silently reverts on the next launch. Comparing the WHOLE object
    // means any future field is covered without a test of its own.
    const store = new Store();
    store.dispatch({
      type: "workspace/restored",
      tabs: [],
      activeTabId: null,
      settings: CUSTOM_SETTINGS,
    });

    expect(await restored(toPersisted(store.getState()))).toEqual(CUSTOM_SETTINGS);
  });

  it("falls back to the defaults for a file written before a setting existed", async () => {
    // An older build's file has no autoCompact at all.
    const { autoCompact: _, ...older } = CUSTOM_SETTINGS;

    const settings = await restored({
      projects: [],
      activeTabId: null,
      settings: older,
    });

    expect(settings.autoCompact).toBe(defaultSettings.autoCompact);
    expect(settings.theme).toBe(CUSTOM_SETTINGS.theme);
  });

  it("uses every default when there are no persisted settings at all", async () => {
    expect(await restored({ projects: [], activeTabId: null })).toEqual(defaultSettings);
  });
});

describe("workspace project round trip", () => {
  it("brings a project's per-project MCP overrides back", async () => {
    const persisted: PersistedWorkspace = {
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
    };
    const store = new Store();
    await new RestoreWorkspace(
      store,
      new FakeWorkspaceStore(persisted),
      gateway,
    ).execute();

    expect(store.getState().tabs[0].project.mcpOverrides).toEqual({
      s1: false,
      s2: true,
    });
  });
});
