import { useEffect, useState } from "react";
import {
  AUTO_COMPACT_POLICIES,
  MAX_AUTO_COMPACT_THRESHOLD,
  MIN_AUTO_COMPACT_THRESHOLD,
} from "../../core/entities/agentSettings";
import { totalBilledTokens } from "../../core/entities/billing";
import type { InsightsRange, InsightsReport } from "../../core/entities/insights";
import { formatUsd } from "../../core/entities/modelPricing";
import { formatTokens } from "../../core/entities/tokens";
import type { AppSettings, TabState } from "../../core/state/appState";
import { BarList, StatTile } from "./InsightsCharts";
import { listPrice } from "./InsightsTokens";
import { OptionPicker } from "./OptionPicker";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  /** The open tabs, for the live per-session usage readout. */
  tabs: readonly TabState[];
  /** The same report the Insights section builds — read here only for
   *  its totals. */
  loadInsights: (range: InsightsRange) => Promise<InsightsReport>;
}

/** The auto-compact ceiling is picked from sane bounds, not free text —
 *  the same bounds the restore clamp enforces, so they cannot drift. */
const THRESHOLD_MIN = MIN_AUTO_COMPACT_THRESHOLD * 100;
const THRESHOLD_MAX = MAX_AUTO_COMPACT_THRESHOLD * 100;

/**
 * UI — everything the agents have consumed on this machine, per vendor.
 *
 * The open sessions below answer "how full is this chat"; this answers
 * "what has Claude cost me", which is the question the word usage
 * usually means. Built from the vendors' own logs when they are readable
 * — those numbers are exact and count re-sent context, which is most of
 * the bill — and from the per-turn context growth the agents report when
 * they are not, marked "≈" so the two are never confused.
 *
 * All time, deliberately: a lifetime total needs no range picker, and
 * the Insights section next door is where a period is chosen.
 */
function TotalUsage({
  loadInsights,
}: {
  loadInsights: (range: InsightsRange) => Promise<InsightsReport>;
}) {
  const [report, setReport] = useState<InsightsReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadInsights("all")
      .then((r) => {
        if (!cancelled) setReport(r);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [loadInsights]);

  if (error !== null) {
    return (
      <>
        <h3 className="settings-section__subtitle">Total usage</h3>
        <p className="insights-error">Could not read your usage: {error}</p>
      </>
    );
  }
  if (report === null) {
    return (
      <>
        <h3 className="settings-section__subtitle">Total usage</h3>
        <p className="settings-section__hint">Adding it up…</p>
      </>
    );
  }
  if (report.totalTurns === 0) {
    return (
      <>
        <h3 className="settings-section__subtitle">Total usage</h3>
        <p className="settings-section__hint">
          Nothing recorded yet — totals build up as you complete turns.
        </p>
      </>
    );
  }

  const { billed, tokens } = report;
  // Exact when a vendor log covered it, estimated otherwise. Never both:
  // two totals for one period invites adding them together.
  const total = billed ? totalBilledTokens(billed.tokens) : tokens.total;
  const costUsd = billed ? billed.costUsd : tokens.estimatedCostUsd;
  const approx = billed ? "" : "≈ ";

  return (
    <>
      <h3 className="settings-section__subtitle">Total usage</h3>
      <div className="insights-tiles">
        <StatTile
          label={billed ? "Billed tokens" : "Tokens"}
          value={`${approx}${formatTokens(total)}`}
          note={billed ? "sent, re-sent context included" : "context growth per turn"}
        />
        <StatTile
          label="Cost"
          value={costUsd === null ? "n/a" : `${approx}${formatUsd(costUsd)}`}
          note="at list price"
        />
        <StatTile label="Turns" value={String(report.totalTurns)} />
        <StatTile label="Conversations" value={String(report.activity.totalSessions)} />
      </div>

      {billed ? (
        <BarList
          rows={billed.byProvider.map((p) => ({
            key: p.provider,
            label: p.provider,
            detail: `${String(p.requests)} requests`,
            value: p.costUsd,
            display: `${formatTokens(totalBilledTokens(p.tokens))} tok · ${listPrice(
              p.costUsd,
            )}`,
          }))}
        />
      ) : (
        <BarList
          rows={tokens.byProvider.map((p) => ({
            key: p.provider,
            label: p.provider,
            value: p.tokens,
            display: `≈ ${formatTokens(p.tokens)} tok`,
          }))}
        />
      )}

      <p className="settings-section__hint">
        {billed
          ? "Read from your providers' own session logs, so this counts the whole conversation each turn re-sends."
          : "No provider log could be read, so this is the context growth the agents reported — less than what was actually sent."}{" "}
        Dollars are list-price arithmetic; on a subscription plan nothing here is charged
        per token. Insights breaks the same numbers down by period, model and project.
      </p>
    </>
  );
}

/**
 * UI — what the agents have consumed in total and per open session, and
 * the knob for how full a session's context may get before it
 * auto-compacts. The window SIZE belongs to each model and cannot be
 * changed here; the ceiling can.
 */
export function SettingsUsage({ settings, onChange, tabs, loadInsights }: Props) {
  const percent = Math.round(settings.autoCompactThreshold * 100);

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Usage</h2>
      <p className="settings-section__hint">
        What your agents have consumed, and how full a session may get before Mota asks
        the agent to compact the conversation. Each session's context window is set by its
        model and cannot be changed here.
      </p>

      <TotalUsage loadInsights={loadInsights} />

      <div className="settings-field">
        <div className="settings-field__text">
          <span className="settings-field__label">When the context fills up</span>
          <span className="settings-field__hint">
            Compacting costs a full pass over the conversation and a fresh cache on the
            next turn; a new chat costs nothing but starts the agent empty.
          </span>
        </div>
        <div className="settings-field__control">
          <OptionPicker
            ariaLabel="What happens when a session's context fills up"
            placement="bottom"
            disabled={false}
            value={settings.autoCompact}
            options={AUTO_COMPACT_POLICIES.map((p) => ({
              id: p.id,
              label: p.label,
              description: p.description,
            }))}
            onChange={(autoCompact) => onChange({ autoCompact })}
          />
        </div>
      </div>

      <div className="settings-field">
        <div className="settings-field__text">
          <span className="settings-field__label">Auto-compact at</span>
          <span className="settings-field__hint">
            Applies to every session. Currently {percent}% of the context window.
          </span>
        </div>
        <div className="settings-field__control usage-threshold">
          <input
            type="range"
            min={THRESHOLD_MIN}
            max={THRESHOLD_MAX}
            step={5}
            value={percent}
            aria-label="Context percentage at which sessions auto-compact"
            onChange={(e) =>
              onChange({ autoCompactThreshold: Number(e.target.value) / 100 })
            }
          />
          <span className="usage-threshold__value">{percent}%</span>
        </div>
      </div>

      <h3 className="settings-section__subtitle">Open sessions</h3>
      <p className="settings-section__hint">
        How full each open conversation's context window is right now.
      </p>
      {tabs.length === 0 && (
        <p className="settings-section__hint">No projects are open.</p>
      )}
      {tabs.map((tab) => {
        const usage = tab.usage;
        const fraction =
          usage && usage.size > 0 ? Math.min(usage.used / usage.size, 1) : 0;
        const over = fraction >= settings.autoCompactThreshold;
        return (
          <div className="usage-row" key={tab.project.id}>
            <div className="usage-row__text">
              <span className="usage-row__name">{tab.project.name}</span>
              <span className="usage-row__provider">{tab.project.provider}</span>
            </div>
            {usage && usage.size > 0 ? (
              <div className="usage-row__reading">
                <div
                  className="usage-row__bar"
                  role="img"
                  aria-label={`${Math.round(fraction * 100)} percent of context used`}
                >
                  <div
                    className={`usage-row__fill ${over ? "usage-row__fill--over" : ""}`}
                    style={{ width: `${fraction * 100}%` }}
                  />
                </div>
                <span className="usage-row__numbers">
                  {usage.estimated || usage.provisional ? "≈ " : ""}
                  {formatTokens(usage.used)} / {formatTokens(usage.size)} (
                  {Math.round(fraction * 100)}%)
                </span>
              </div>
            ) : (
              <span className="usage-row__numbers usage-row__numbers--none">
                No usage reported yet
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
