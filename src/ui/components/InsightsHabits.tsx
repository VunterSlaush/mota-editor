import type { InsightsReport } from "../../core/entities/insights";
import { BarList, SplitBar, StatTile } from "./InsightsCharts";

/** Above this share of interrupted turns the tile calls it out. */
const CANCELLED_ALERT = 0.2;

/** UI — how the user drives the agents: commands, modes, interruptions. */
export function InsightsHabits({ report }: { report: InsightsReport }) {
  const { habits } = report;
  const cancelledPercent = Math.round(habits.cancelledRate * 100);
  const abnormal = Object.entries(habits.abnormalStops).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );

  return (
    <section className="insights-group">
      <h3 className="settings-section__subtitle">Habits</h3>
      <div className="insights-tiles">
        <StatTile
          label="Interrupted turns"
          value={`${String(cancelledPercent)}%`}
          note={
            habits.cancelledRate > CANCELLED_ALERT
              ? "high — prompts going astray?"
              : undefined
          }
          alert={habits.cancelledRate > CANCELLED_ALERT}
        />
      </div>

      <SplitBar label="Mode" parts={habits.modeSplit} />
      <SplitBar label="Permission" parts={habits.permissionSplit} />
      <SplitBar label="Effort" parts={habits.effortSplit} />

      {habits.commands.length > 0 && (
        <>
          <span className="insights-caption">Slash commands</span>
          <BarList
            rows={habits.commands.slice(0, 8).map((c) => ({
              key: c.command,
              label: c.command,
              value: c.count,
              display: `${String(c.count)}×`,
            }))}
          />
        </>
      )}

      {abnormal.length > 0 && (
        <>
          <span className="insights-caption">Turns that didn't finish normally</span>
          <BarList
            rows={abnormal.map(([reason, count]) => ({
              key: reason,
              label: reason,
              value: count,
              display: `${String(count)}×`,
            }))}
          />
        </>
      )}
    </section>
  );
}
