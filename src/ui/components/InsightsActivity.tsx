import { formatElapsed } from "../../core/entities/duration";
import type { InsightsRange, InsightsReport } from "../../core/entities/insights";
import { formatTokens } from "../../core/entities/tokens";
import { BarList, DayBarChart, Heatmap, MiniBars, StatTile } from "./InsightsCharts";

const HOUR_LABELS = Array.from(
  { length: 24 },
  (_, h) => `${String(h).padStart(2, "0")}:00`,
);
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** UI — when and where the agent work happens. */
export function InsightsActivity({
  report,
  range,
}: {
  report: InsightsReport;
  range: InsightsRange;
}) {
  const { activity, totalTurns } = report;
  const turns = (n: number) => `${String(n)} ${n === 1 ? "turn" : "turns"}`;
  const dayPoints = activity.days.map((d) => ({ day: d.day, value: d.turns }));

  return (
    <section className="insights-group">
      <h3 className="settings-section__subtitle">Activity</h3>
      <div className="insights-tiles">
        <StatTile label="Turns" value={String(totalTurns)} />
        <StatTile label="Sessions" value={String(activity.totalSessions)} />
        <StatTile label="Agent time" value={formatElapsed(activity.totalAgentTimeMs)} />
        <StatTile
          label="Avg turn"
          value={
            activity.avgTurnDurationMs !== null
              ? formatElapsed(activity.avgTurnDurationMs)
              : "—"
          }
        />
      </div>

      {range === "all" ? (
        <Heatmap days={dayPoints} formatValue={turns} />
      ) : (
        <DayBarChart points={dayPoints} ariaLabel="Turns per day" formatValue={turns} />
      )}

      <div className="insights-distributions">
        <div>
          <span className="insights-caption">By hour</span>
          <MiniBars
            values={activity.byHour}
            labels={HOUR_LABELS}
            ariaLabel="Turns by hour of day"
            formatValue={turns}
          />
        </div>
        <div>
          <span className="insights-caption">By weekday</span>
          <MiniBars
            values={activity.byWeekday}
            labels={WEEKDAY_LABELS}
            ariaLabel="Turns by weekday"
            formatValue={turns}
          />
        </div>
      </div>

      {activity.byProject.length > 0 && (
        <>
          <span className="insights-caption">Projects</span>
          <BarList
            rows={activity.byProject.map((p) => ({
              key: p.key,
              label: p.label,
              value: p.turns,
              display: `${turns(p.turns)} · ${formatElapsed(p.agentTimeMs)} · ${formatTokens(p.tokens)} tok`,
            }))}
          />
        </>
      )}
    </section>
  );
}
