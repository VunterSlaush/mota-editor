import { describe, expect, it } from "vitest";
import type { BilledRequest } from "../entities/billing";
import type { SessionStats } from "../entities/insights";
import { newProject } from "../entities/project";
import type { BillingStore } from "../ports/billingStore";
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
  async listExternal() {
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

class FakeBillingStore implements BillingStore {
  requests: BilledRequest[] = [];
  askedFor: (readonly string[])[] = [];
  async readBilledUsage(sessionIds: readonly string[]): Promise<BilledRequest[]> {
    this.askedFor.push(sessionIds);
    return this.requests;
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
        title: "A session",
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

    const report = await new LoadInsights(
      store,
      transcripts,
      new FakeBillingStore(),
    ).execute("7d");

    expect(transcripts.statsCalls).toEqual([["/work/alpha", "/work/beta"]]);
    expect(report.totalTurns).toBe(1);
    expect(report.tokens.total).toBe(500);
    expect(report.activity.days).toHaveLength(7);
  });

  it("returns the empty report when nothing is persisted", async () => {
    const store = new Store();
    const report = await new LoadInsights(
      store,
      new FakeTranscriptStore(),
      new FakeBillingStore(),
    ).execute("all");
    expect(report.totalTurns).toBe(0);
    expect(report.activity.days).toEqual([]);
  });

  it("asks the vendor logs only about sessions that recorded an id", async () => {
    // Sessions with no provider id cannot be joined to a vendor log;
    // asking about their local ids would match a stranger's session or
    // nothing at all.
    const store = new Store();
    const transcripts = new FakeTranscriptStore();
    transcripts.stats = [
      session("s1", "claude-1"),
      session("s2", undefined),
      session("s3", "claude-3"),
    ];
    const billing = new FakeBillingStore();

    await new LoadInsights(store, transcripts, billing).execute("all");

    expect(billing.askedFor).toEqual([["claude-1", "claude-3"]]);
  });

  it("reports exact spend for sessions the vendor logged", async () => {
    const store = new Store();
    const transcripts = new FakeTranscriptStore();
    transcripts.stats = [session("s1", "claude-1")];
    const billing = new FakeBillingStore();
    billing.requests = [
      {
        requestId: "r1",
        sessionId: "claude-1",
        timestampMs: Date.now(),
        model: "claude-opus-5",
        isSidechain: false,
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheWrite5mTokens: 0,
        cacheWrite1hTokens: 0,
        cacheReadTokens: 0,
      },
    ];

    const report = await new LoadInsights(store, transcripts, billing).execute("all");

    expect(report.billed?.costUsd).toBeCloseTo(5); // opus input, $5/M
    expect(report.billed?.billedSessions).toBe(1);
  });
});

function session(id: string, providerSessionId: string | undefined): SessionStats {
  return {
    sessionId: id,
    providerSessionId,
    title: `Session ${id}`,
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
  };
}
