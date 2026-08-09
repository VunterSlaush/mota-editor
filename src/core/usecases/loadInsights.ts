import {
  buildInsights,
  type InsightsRange,
  type InsightsReport,
} from "../entities/insights";
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
    const state = this.store.getState();
    const knownProjects = state.tabs.map((tab) => tab.project.path);
    const sessions = await this.transcriptStore.listStats(knownProjects);
    const providerSessionIds = sessions
      .map((session) => session.providerSessionId)
      .filter((id): id is string => id !== undefined);
    const billed = await this.billingStore.readBilledUsage(providerSessionIds);
    return buildInsights(sessions, {
      range,
      now: Date.now(),
      autoCompactThreshold: state.settings.autoCompactThreshold,
      billed,
    });
  }
}
