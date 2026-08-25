import { useEffect, useState } from "react";
import type { InsightsRange, InsightsReport } from "../../core/entities/insights";
import { InsightsActivity } from "./InsightsActivity";
import { InsightsGrowth } from "./InsightsGrowth";
import { InsightsHabits } from "./InsightsHabits";
import { InsightsTokens } from "./InsightsTokens";
import { InsightsTools } from "./InsightsTools";

interface Props {
  loadInsights: (range: InsightsRange) => Promise<InsightsReport>;
}

const RANGES: readonly { id: InsightsRange; label: string }[] = [
  { id: "today", label: "Today" },
  { id: "7d", label: "7 days" },
  { id: "30d", label: "30 days" },
  { id: "all", label: "All time" },
];

/**
 * UI — historical usage statistics over the persisted transcripts: how
 * you work with agents and what it consumes. Read-only; the report is
 * section-local state, rebuilt whenever the range changes.
 */
export function SettingsInsights({ loadInsights }: Props) {
  const [range, setRange] = useState<InsightsRange>("30d");
  const [report, setReport] = useState<InsightsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    loadInsights(range)
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [range, loadInsights]);

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Insights</h2>
      <p className="settings-section__hint">
        How you work with agents, built from your saved sessions on this machine.
      </p>

      <div className="insights-range" role="tablist" aria-label="Time range">
        {RANGES.map((r) => (
          <button
            type="button"
            key={r.id}
            role="tab"
            aria-selected={range === r.id}
            className={`insights-range__option ${
              range === r.id ? "insights-range__option--active" : ""
            }`}
            onClick={() => setRange(r.id)}
          >
            {r.label}
          </button>
        ))}
      </div>

      {error !== null && (
        <p className="insights-error">Could not load insights: {error}</p>
      )}
      {error === null && report === null && (
        <p className="settings-section__hint">Crunching your sessions…</p>
      )}
      {error === null && report !== null && report.totalTurns === 0 && (
        <p className="settings-section__hint">
          No agent activity recorded {range === "all" ? "yet" : "in this period"}.
          Insights build up as you complete turns.
        </p>
      )}
      {error === null && report !== null && report.totalTurns > 0 && (
        <>
          <InsightsActivity report={report} range={range} />
          <InsightsTokens report={report} />
          <InsightsGrowth report={report} />
          <InsightsHabits report={report} />
          <InsightsTools report={report} />
        </>
      )}
    </div>
  );
}
