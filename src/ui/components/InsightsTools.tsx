import type { InsightsReport } from "../../core/entities/insights";
import { BarList } from "./InsightsCharts";

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

/** UI — what the agents actually do: tool calls and the files they touch. */
export function InsightsTools({ report }: { report: InsightsReport }) {
  const { tools } = report;
  const kinds = Object.entries(tools.totalsByKind).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );

  return (
    <section className="insights-group">
      <h3 className="settings-section__subtitle">Tools</h3>
      {kinds.length === 0 && (
        <p className="settings-section__hint">No tool calls recorded in this period.</p>
      )}
      {kinds.length > 0 && (
        <BarList
          rows={kinds.map(([kind, total]) => ({
            key: kind,
            label: kind,
            value: total,
            display: `${String(total)}× · ${(tools.avgPerTurnByKind[kind] ?? 0).toFixed(1)}/turn`,
          }))}
        />
      )}

      {tools.topFiles.length > 0 && (
        <>
          <span className="insights-caption">Most-touched files</span>
          <BarList
            rows={tools.topFiles.map((f) => ({
              key: f.path,
              label: basename(f.path),
              detail: f.path,
              value: f.touches,
              display: `${String(f.touches)}×`,
            }))}
          />
        </>
      )}
    </section>
  );
}
