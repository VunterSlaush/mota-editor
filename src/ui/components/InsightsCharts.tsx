/**
 * UI — hand-rolled chart primitives for the settings Insights section.
 * All fills come from theme custom properties so every theme recolors
 * them; identity is always carried by text labels, never color alone.
 * No business logic here — data arrives pre-aggregated.
 */

export function StatTile({
  label,
  value,
  note,
  alert,
}: {
  label: string;
  value: string;
  note?: string;
  alert?: boolean;
}) {
  return (
    <div className={`insights-tile ${alert ? "insights-tile--alert" : ""}`}>
      <span className="insights-tile__value">{value}</span>
      <span className="insights-tile__label">{label}</span>
      {note !== undefined && <span className="insights-tile__note">{note}</span>}
    </div>
  );
}

/** Single-series bar chart over ordered day buckets (one hue). */
export function DayBarChart({
  points,
  ariaLabel,
  formatValue,
}: {
  points: readonly { readonly day: string; readonly value: number }[];
  ariaLabel: string;
  formatValue: (value: number) => string;
}) {
  if (points.length === 0) return null;
  const W = 600;
  const H = 96;
  const AXIS = 14;
  const max = Math.max(...points.map((p) => p.value), 1);
  const gap = points.length > 60 ? 0.5 : 2;
  const slot = W / points.length;
  return (
    <svg
      className="insights-chart"
      viewBox={`0 0 ${W} ${H + AXIS}`}
      role="img"
      aria-label={ariaLabel}
    >
      {points.map((p, i) => {
        const h = p.value > 0 ? Math.max((p.value / max) * H, 2) : 0;
        return (
          <rect
            key={p.day}
            className="insights-chart__bar"
            x={i * slot + gap / 2}
            y={H - h}
            width={Math.max(slot - gap, 0.75)}
            height={h}
            rx={Math.min(2, slot / 4)}
          >
            <title>{`${p.day}: ${formatValue(p.value)}`}</title>
          </rect>
        );
      })}
      <text className="insights-chart__axis" x={0} y={H + AXIS - 2}>
        {points[0].day}
      </text>
      <text className="insights-chart__axis" x={W} y={H + AXIS - 2} textAnchor="end">
        {points[points.length - 1].day}
      </text>
    </svg>
  );
}

/** GitHub-style year heatmap: week columns × 7 weekday rows, opacity
 *  ramp of the accent hue (sequential = one hue, light→dark). */
export function Heatmap({
  days,
  formatValue,
}: {
  days: readonly { readonly day: string; readonly value: number }[];
  formatValue: (value: number) => string;
}) {
  if (days.length === 0) return null;
  const max = Math.max(...days.map((d) => d.value), 1);
  // Column flow needs the first cell to sit on its weekday row.
  const lead = new Date(`${days[0].day}T00:00:00`).getDay();
  return (
    <div className="insights-heatmap" role="img" aria-label="Activity per day">
      {Array.from({ length: lead }, (_, i) => (
        <span
          key={`pad-${String(i)}`}
          className="insights-heatmap__cell insights-heatmap__cell--pad"
        />
      ))}
      {days.map((d) => (
        <span
          key={d.day}
          className={`insights-heatmap__cell ${d.value > 0 ? "insights-heatmap__cell--active" : ""}`}
          style={d.value > 0 ? { opacity: 0.25 + 0.75 * (d.value / max) } : undefined}
          title={`${d.day}: ${formatValue(d.value)}`}
        />
      ))}
    </div>
  );
}

/** Tiny distribution bars (hours of day, weekdays). The peak is
 *  emphasized by full opacity, not by a different (status) color. */
export function MiniBars({
  values,
  labels,
  ariaLabel,
  formatValue,
}: {
  values: readonly number[];
  labels: readonly string[];
  ariaLabel: string;
  formatValue: (value: number) => string;
}) {
  const max = Math.max(...values, 1);
  const peak = values.indexOf(Math.max(...values));
  return (
    <div className="insights-minibars" role="img" aria-label={ariaLabel}>
      {values.map((v, i) => (
        <div
          key={labels[i]}
          className="insights-minibars__col"
          title={`${labels[i]}: ${formatValue(v)}`}
        >
          <div
            className={`insights-minibars__bar ${
              i === peak && v > 0 ? "insights-minibars__bar--peak" : ""
            }`}
            style={{ height: `${Math.max((v / max) * 100, v > 0 ? 4 : 0)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

export interface BarRow {
  readonly key: string;
  readonly label: string;
  /** Dim secondary text after the label (provider, full path...). */
  readonly detail?: string;
  readonly value: number;
  /** Right-aligned reading, e.g. "12k tokens · ≈ $0.40". */
  readonly display: string;
}

/** Ranked single-hue horizontal bars — identity lives in the labels. */
export function BarList({ rows }: { rows: readonly BarRow[] }) {
  if (rows.length === 0) return null;
  const max = Math.max(...rows.map((r) => r.value), 1);
  return (
    <div className="insights-bar-list">
      {rows.map((row) => (
        <div className="insights-bar-list__row" key={row.key} title={row.display}>
          <span className="insights-bar-list__label">
            {row.label}
            {row.detail !== undefined && (
              <span className="insights-bar-list__detail"> {row.detail}</span>
            )}
          </span>
          <span className="insights-bar-list__track">
            <span
              className="insights-bar-list__fill"
              style={{ width: `${(row.value / max) * 100}%` }}
            />
          </span>
          <span className="insights-bar-list__value">{row.display}</span>
        </div>
      ))}
    </div>
  );
}

/** Categorical hues in fixed order; the legend carries identity. */
const SPLIT_TONES = 5;

/** One stacked horizontal bar with 2px surface gaps and a legend of
 *  "name count" chips — never more than five segments. */
export function SplitBar({
  label,
  parts,
  formatValue = String,
}: {
  label: string;
  parts: Readonly<Record<string, number>>;
  /** Renders each segment's reading; defaults to the bare number. Costs
   *  pass a currency formatter so "0.42" reads as "$0.42". */
  formatValue?: (value: number) => string;
}) {
  const entries = Object.entries(parts).sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  if (entries.length === 0) return null;
  const shown = entries.slice(0, SPLIT_TONES - 1);
  const rest = entries.slice(SPLIT_TONES - 1);
  const folded =
    rest.length > 0
      ? [...shown, ["other", rest.reduce((sum, [, n]) => sum + n, 0)] as const]
      : shown;
  const total = folded.reduce((sum, [, n]) => sum + n, 0);
  return (
    <div className="insights-split">
      <span className="insights-split__label">{label}</span>
      <div className="insights-split__bar" role="img" aria-label={label}>
        {folded.map(([name, count], i) => (
          <span
            key={name}
            className={`insights-split__seg insights-split__seg--${String(i)}`}
            style={{ flexGrow: count }}
            title={`${name}: ${formatValue(count)}`}
          />
        ))}
      </div>
      <div className="insights-split__legend">
        {folded.map(([name, count], i) => (
          <span className="insights-split__chip" key={name}>
            <span
              className={`insights-split__swatch insights-split__seg--${String(i)}`}
            />
            {name} <span className="insights-split__count">{formatValue(count)}</span>
            <span className="insights-split__count">
              ({total > 0 ? Math.round((count / total) * 100) : 0}%)
            </span>
          </span>
        ))}
      </div>
    </div>
  );
}
