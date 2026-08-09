import type { InsightsReport } from "../../core/entities/insights";
import { formatTokens } from "../../core/entities/tokens";
import { DayBarChart, StatTile } from "./InsightsCharts";

/**
 * UI — what conversation length does to the bill.
 *
 * The one Insights section that explains most of the spend: every turn
 * re-sends the whole conversation, so the hundredth turn pays for the
 * ninety-nine before it. Nothing else here is actionable in the same way
 * — the fix is to start a new chat sooner, and this is the number that
 * says when.
 */
export function InsightsGrowth({ report }: { report: InsightsReport }) {
  const { growth } = report;
  if (growth.byPosition.length === 0) return null;
  const approx = growth.estimated ? "≈ " : "";

  return (
    <section className="insights-group">
      <h3 className="settings-section__subtitle">Conversation growth</h3>

      <div className="insights-tiles">
        <StatTile
          label="Avg conversation"
          value={`${growth.avgTurnsPerConversation.toFixed(1)} turns`}
        />
        <StatTile
          label="Late-turn cost"
          value={
            growth.lateMultiple !== null ? `${growth.lateMultiple.toFixed(1)}x` : "—"
          }
          note="a late turn vs an early one"
          // Past ~3x, re-sent history is most of what each turn pays for.
          alert={growth.lateMultiple !== null && growth.lateMultiple >= 3}
        />
        <StatTile
          label={`After turn ${String(growth.lateTurn)}`}
          value={`${approx}${String(Math.round(growth.lateShare * 100))}%`}
          note="of all tokens"
        />
      </div>

      <DayBarChart
        points={growth.byPosition.map((b) => ({ day: b.band, value: b.avgTokens }))}
        ariaLabel="Average tokens per turn, by position in the conversation"
        formatValue={(v) => `${approx}${formatTokens(v)} tokens / turn`}
      />

      <p className="settings-section__hint">
        Turn position, left to right — each bar is what one turn costs at that depth.
        Every turn re-sends the conversation so far, so cost compounds with length. A new
        chat resets it to nothing; compacting only trims it.
      </p>
    </section>
  );
}
