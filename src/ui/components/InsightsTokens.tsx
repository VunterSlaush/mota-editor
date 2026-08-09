import type { BilledSpend, InsightsReport } from "../../core/entities/insights";
import { formatTokens } from "../../core/entities/tokens";
import { BarList, DayBarChart, SplitBar, StatTile } from "./InsightsCharts";

function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Estimated money always carries the "≈"; exact money never does. */
function formatCost(usd: number | null): string {
  if (usd === null) return "n/a";
  return `≈ ${formatUsd(usd)}`;
}

function formatPercent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/** UI — what the sessions consume: tokens, models, and cost. */
export function InsightsTokens({ report }: { report: InsightsReport }) {
  const { tokens, billed } = report;
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
        {/* The exact figure displaces the estimate rather than sitting
            beside it: two cost numbers for one range invites adding them
            together, and they overlap. */}
        {billed ? (
          <StatTile
            label="Billed cost"
            value={formatUsd(billed.costUsd)}
            note={
              billed.estimatedSessions > 0
                ? `${String(billed.billedSessions)} of ${String(
                    billed.billedSessions + billed.estimatedSessions,
                  )} sessions`
                : undefined
            }
          />
        ) : (
          <StatTile label="Est. cost" value={formatCost(tokens.estimatedCostUsd)} />
        )}
        <StatTile label="Compactions" value={String(tokens.compactionTurns)} />
      </div>

      <DayBarChart
        points={tokens.days.map((d) => ({ day: d.day, value: d.tokens }))}
        ariaLabel="Tokens per day"
        formatValue={fmt}
      />

      {billed && <BilledSpendView billed={billed} />}

      {tokens.byModel.length > 0 && !billed && (
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
        billed API tokens; any cost marked "≈" is a rough estimate at blended list rates.
      </p>
    </section>
  );
}

/**
 * The exact half of the report. Everything here comes from the vendor's
 * own log, so nothing carries an "≈" — the only hedge is naming how many
 * sessions this does NOT cover.
 */
function BilledSpendView({ billed }: { billed: BilledSpend }) {
  const cacheHealth = billed.cacheHitRate;
  return (
    <>
      <span className="insights-caption">Billed spend</span>
      <div className="insights-tiles">
        <StatTile
          label="Cache hit rate"
          value={cacheHealth !== null ? formatPercent(cacheHealth) : "—"}
          // A long conversation should sit high: every turn re-sends a
          // prefix the vendor already has. Low means something keeps
          // breaking it and it is being paid for at write rates.
          alert={cacheHealth !== null && cacheHealth < 0.5}
          note="of input served from cache"
        />
        <StatTile
          label="Cache writes"
          value={formatUsd(billed.costByKind.cacheWrite)}
          note="cost of re-sending context"
        />
        <StatTile
          label="Subagents"
          value={formatUsd(billed.sidechainCostUsd)}
          note={
            billed.costUsd > 0
              ? `${formatPercent(billed.sidechainCostUsd / billed.costUsd)} of spend`
              : undefined
          }
        />
      </div>

      <SplitBar
        label="Where the money went"
        parts={{
          input: billed.costByKind.input,
          output: billed.costByKind.output,
          "cache write": billed.costByKind.cacheWrite,
          "cache read": billed.costByKind.cacheRead,
        }}
        formatValue={formatUsd}
      />

      {billed.bySession.length > 1 && (
        <>
          <span className="insights-caption">Cost per session</span>
          <BarList
            rows={billed.bySession.slice(0, 10).map((s) => ({
              key: s.sessionId,
              label: s.label,
              value: s.costUsd,
              display: formatUsd(s.costUsd),
            }))}
          />
        </>
      )}

      {billed.byModel.length > 0 && (
        <>
          <span className="insights-caption">By model (billed)</span>
          <BarList
            rows={billed.byModel.map((m) => ({
              key: `${m.provider}|${m.model}`,
              label: m.model,
              detail: `${String(m.requests)} requests`,
              value: m.costUsd,
              display: formatUsd(m.costUsd),
            }))}
          />
        </>
      )}

      {billed.estimatedSessions > 0 && (
        <p className="insights-note">
          {billed.estimatedSessions}{" "}
          {billed.estimatedSessions === 1 ? "session has" : "sessions have"} no vendor log
          and {billed.estimatedSessions === 1 ? "is" : "are"} not included above — those
          stay on the estimated figures.
        </p>
      )}
    </>
  );
}
