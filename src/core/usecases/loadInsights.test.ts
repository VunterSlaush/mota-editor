import { describe, expect, it } from "vitest";
import type { SessionStats } from "../entities/insights";
import { newProject } from "../entities/project";
import type {
  PersistedTranscript,
  TranscriptMeta,
  TranscriptStore,
} from "../ports/transcriptStore";
import { defaultSettings, projectDefaults } from "../state/appState";
import { Store } from "../state/store";
import { LoadInsights } from "./loadInsights";

class FakeTranscriptStore implements TranscriptStore {
  stats: SessionStats[] = [];
  statsCalls: (readonly string[])[] = [];
  async save(): Promise<void> {}
  async list(): Promise<TranscriptMeta[]> {
    return [];
  }
  async load(): Promise<PersistedTranscript | null> {
    return null;
  }
  async remove(): Promise<void> {}
  async readPlanFile(): Promise<string | null> {
    return null;
  }
  async listStats(knownProjects: readonly string[]): Promise<SessionStats[]> {
    this.statsCalls.push(knownProjects);
    return this.stats;
  }
}

const DEFAULTS = projectDefaults(defaultSettings);

describe("LoadInsights", () => {
  it("passes open-tab paths to the store and builds a report", async () => {
    const store = new Store();
    store.dispatch({
      type: "tab/opened",
      project: newProject("t1", "/work/alpha", DEFAULTS),
    });
    store.dispatch({
      type: "tab/opened",
      project: newProject("t2", "/work/beta", DEFAULTS),
    });
    const transcripts = new FakeTranscriptStore();
    transcripts.stats = [
      {
        sessionId: "s1",
        projectDirHash: "h",
        provider: "claude",
        savedAt: Date.now(),
        turns: [
          {
            sentAt: Date.now() - 1_000,
            mode: "normal",
            permission: "default",
            tokens: 500,
            toolCounts: {},
          },
        ],
        touchedFiles: {},
      },
    ];

    const report = await new LoadInsights(store, transcripts).execute("7d");

    expect(transcripts.statsCalls).toEqual([["/work/alpha", "/work/beta"]]);
    expect(report.totalTurns).toBe(1);
    expect(report.tokens.total).toBe(500);
    expect(report.activity.days).toHaveLength(7);
  });

  it("returns the empty report when nothing is persisted", async () => {
    const store = new Store();
    const report = await new LoadInsights(store, new FakeTranscriptStore()).execute(
      "all",
    );
    expect(report.totalTurns).toBe(0);
    expect(report.activity.days).toEqual([]);
  });
});
