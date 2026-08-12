import type { BilledRequest } from "../entities/billing";
import {
  buildInsights,
  type CommandSavings,
  commandSavings,
  type InsightsRange,
  type InsightsReport,
  type SessionStats,
} from "../entities/insights";
import type { ProviderId } from "../entities/provider";
import type { BillingStore } from "../ports/billingStore";
import type { TranscriptStore } from "../ports/transcriptStore";
import type { Store } from "../state/store";

/**
 * Use case — build the historical usage report for the settings
 * Insights section. The report is returned to the caller (section-local
 * state, like provider probing), not dispatched into app state.
 *
 * Two sources, and the order matters: the transcripts say WHICH
 * conversations happened, and only then can the vendors' logs be asked
 * what those conversations cost. Sessions with no readable log keep the
 * estimate rather than dropping out of the report.
 */
export class LoadInsights {
  constructor(
    private readonly store: Store,
    private readonly transcriptStore: TranscriptStore,
    private readonly billingStore: BillingStore,
  ) {}

  async execute(range: InsightsRange): Promise<InsightsReport> {
    const { sessions, billed } = await this.loadSources();
    return buildInsights(sessions, {
      range,
      now: Date.now(),
      autoCompactThreshold: this.store.getState().settings.autoCompactThreshold,
      billed,
    });
  }

  /** Tokens one optimized command has saved, for its settings row. */
  async savings(
    provider: ProviderId,
    command: string,
    activatedAt: number,
  ): Promise<CommandSavings> {
    const { sessions, billed } = await this.loadSources();
    return commandSavings(sessions, billed, provider, command, activatedAt);
  }

  private async loadSources(): Promise<{
    sessions: readonly SessionStats[];
    billed: readonly BilledRequest[];
  }> {
    const state = this.store.getState();
    const knownProjects = state.tabs.map((tab) => tab.project.path);
    const sessions = await this.transcriptStore.listStats(knownProjects);
    const providerSessionIds = sessions
      .map((session) => session.providerSessionId)
      .filter((id): id is string => id !== undefined);
    const billed = await this.billingStore.readBilledUsage(providerSessionIds);
    return { sessions, billed };
  }
}
