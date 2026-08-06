import type { InsightsReport } from "../../core/entities/insights";
import { formatTokens } from "../../core/entities/tokens";
import { BarList, DayBarChart, StatTile } from "./InsightsCharts";

function formatCost(usd: number | null): string {
  if (usd === null) return "n/a";
  if (usd > 0 && usd < 0.01) return "≈ <$0.01";
  return `≈ $${usd.toFixed(2)}`;
}

/** UI — what the sessions consume: tokens, models, rough cost. */
export function InsightsTokens({ report }: { report: InsightsReport }) {
  const { tokens } = report;
  const approx = tokens.estimatedShare > 0 ? "≈ " : "";
  const fmt = (n: number) => `${formatTokens(n)} tokens`;

  return (
    <section className="insights-group">
      <h3 className="settings-section__subtitle">Tokens</h3>
      <div className="insights-tiles">
        <StatTile label="Total" value={`${approx}${formatTokens(tokens.total)}`} />
        <StatTile
          label="Avg / turn"
          value={tokens.avgPerTurn !== null ? formatTokens(tokens.avgPerTurn) : "—"}
        />
        <StatTile label="Est. cost" value={formatCost(tokens.estimatedCostUsd)} />
        <StatTile label="Compactions" value={String(tokens.compactionTurns)} />
      </div>

      <DayBarChart
        points={tokens.days.map((d) => ({ day: d.day, value: d.tokens }))}
        ariaLabel="Tokens per day"
        formatValue={fmt}
      />

      {tokens.byModel.length > 0 && (
        <>
          <span className="insights-caption">By model</span>
          <BarList
            rows={tokens.byModel.map((m) => ({
              key: `${m.provider}|${m.model}`,
              label: m.model,
              detail: m.provider,
              value: m.tokens,
              display: `${formatTokens(m.tokens)} tok · ${formatCost(m.costUsd)}`,
            }))}
          />
        </>
      )}

      {tokens.byProvider.length > 1 && (
        <>
          <span className="insights-caption">By provider</span>
          <BarList
            rows={tokens.byProvider.map((p) => ({
              key: p.provider,
              label: p.provider,
              value: p.tokens,
              display: `${formatTokens(p.tokens)} tok`,
            }))}
          />
        </>
      )}

      {tokens.sessionsNearThreshold > 0 && (
        <p className="insights-note">
          {tokens.sessionsNearThreshold}{" "}
          {tokens.sessionsNearThreshold === 1 ? "session" : "sessions"} crossed your
          auto-compact ceiling (estimated).
        </p>
      )}
      <p className="settings-section__hint">
        Token figures are context-window growth per turn as reported by the agent, not
        billed API tokens; cost is a rough estimate at blended list rates.
      </p>
    </section>
  );
}
