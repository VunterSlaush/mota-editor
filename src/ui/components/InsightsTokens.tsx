import { totalBilledTokens } from "../../core/entities/billing";
import type { BilledSpend, InsightsReport } from "../../core/entities/insights";
import { formatUsd } from "../../core/entities/modelPricing";
import { formatTokens } from "../../core/entities/tokens";
import { BarList, DayBarChart, SplitBar, StatTile } from "./InsightsCharts";

/** Estimated money always carries the "≈"; exact money never does. */
function formatCost(usd: number | null): string {
  if (usd === null) return "n/a";
  return `≈ ${formatUsd(usd)}`;
}

function formatPercent(fraction: number): string {
  return `${String(Math.round(fraction * 100))}%`;
}

/**
 * Money, said as what it is: list-price arithmetic over the tokens the
 * vendor reported. On a subscription nothing here is charged per token,
 * so an unqualified dollar figure would be read as a bill that does not
 * exist. Shared with the Usage section, which shows the same totals.
 */
export function listPrice(usd: number): string {
  return `${formatUsd(usd)} at list price`;
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
        {/* Tokens lead, money follows. On a subscription the dollars are
            nobody's invoice, and tokens are what the limits are counted
            in — so the figure people act on is the token count. */}
        {billed ? (
          <StatTile
            label="Billed tokens"
            value={formatTokens(totalBilledTokens(billed.tokens))}
            note={`${listPrice(billed.costUsd)}${
              billed.estimatedSessions > 0
                ? ` · ${String(billed.billedSessions)} of ${String(
                    billed.billedSessions + billed.estimatedSessions,
                  )} sessions`
                : ""
            }`}
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

      {tokens.byCommand.length > 0 && (
        <>
          <span className="insights-caption">Most expensive commands</span>
          <BarList
            rows={tokens.byCommand.slice(0, 10).map((c) => ({
              key: c.command,
              label: c.command,
              detail: `${String(c.turns)} ${c.turns === 1 ? "run" : "runs"}`,
              value: c.tokens,
              display: `${c.estimated ? "≈ " : ""}${formatTokens(c.tokens)} tok`,
            }))}
          />
        </>
      )}

      {tokens.coldStarts.length > 0 && (
        <>
          <span className="insights-caption">Costliest folders to start a chat in</span>
          <BarList
            rows={tokens.coldStarts.slice(0, 10).map((f) => ({
              key: f.key,
              label: f.label,
              detail: `${String(f.conversations)} ${
                f.conversations === 1 ? "chat" : "chats"
              }`,
              value: f.avgTokens,
              display: `${f.estimated ? "≈ " : ""}${formatTokens(f.avgTokens)} tok / chat`,
            }))}
          />
          <p className="settings-section__hint">
            What the first turn of a new chat costs there — the system prompt, every tool
            schema, and the project's own CLAUDE.md or AGENTS.md. Every new chat pays it
            again, so it is the one token cost a project can be edited to reduce.
          </p>
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
        Token figures without a "billed" label are context-window growth per turn as
        reported by the agent, not tokens actually sent; any cost marked "≈" is a rough
        estimate at blended list rates. Dollar figures are list-price arithmetic over the
        tokens your provider reported — on a subscription plan nothing here is charged per
        token, so treat them as a size, not an invoice.
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
          value={formatTokens(
            billed.tokens.cacheWrite5mTokens + billed.tokens.cacheWrite1hTokens,
          )}
          note={`context re-sent · ${listPrice(billed.costByKind.cacheWrite)}`}
        />
        <StatTile
          label="Subagents"
          value={
            billed.costUsd > 0
              ? formatPercent(billed.sidechainCostUsd / billed.costUsd)
              : "—"
          }
          note={`of spend · ${listPrice(billed.sidechainCostUsd)}`}
        />
      </div>

      {/* Weighted by cost, not tokens, and labelled as such: cache reads
          are ~98% of tokens but well under that of the cost, so a
          token-weighted split would be one bar and say nothing. */}
      <SplitBar
        label="Where it went (weighted by list price)"
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
          <span className="insights-caption">Dearest sessions</span>
          <BarList
            rows={billed.bySession.slice(0, 10).map((s) => ({
              key: s.sessionId,
              label: s.label,
              value: s.costUsd,
              display: listPrice(s.costUsd),
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
              display: `${formatTokens(totalBilledTokens(m.tokens))} tok · ${formatUsd(
                m.costUsd,
              )}`,
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
