import {
  buildInsights,
  type InsightsRange,
  type InsightsReport,
} from "../entities/insights";
import type { TranscriptStore } from "../ports/transcriptStore";
import type { Store } from "../state/store";

/**
 * Use case — build the historical usage report for the settings
 * Insights section. The report is returned to the caller (section-local
 * state, like provider probing), not dispatched into app state.
 */
export class LoadInsights {
  constructor(
    private readonly store: Store,
    private readonly transcriptStore: TranscriptStore,
  ) {}

  async execute(range: InsightsRange): Promise<InsightsReport> {
    const state = this.store.getState();
    const knownProjects = state.tabs.map((tab) => tab.project.path);
    const sessions = await this.transcriptStore.listStats(knownProjects);
    return buildInsights(sessions, {
      range,
      now: Date.now(),
      autoCompactThreshold: state.settings.autoCompactThreshold,
    });
  }
}
