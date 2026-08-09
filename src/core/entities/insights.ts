import {
  addBilled,
  type BilledRequest,
  type BilledTokens,
  cacheHitRate,
  NO_BILLED_TOKENS,
  sumBilled,
} from "./billing";
import { billedCostUsd, estimateCostUsd } from "./modelPricing";
import { COMPACT_COMMAND, PROVIDERS } from "./provider";

/**
 * Entities layer — historical usage statistics ("Insights") built from
 * persisted transcripts. Pure aggregation: no React, no Tauri, no IO.
 *
 * Token figures everywhere in this module are CONTEXT-WINDOW DELTAS per
 * turn (what ACP reports), not billed API tokens — displays must mark
 * them and any derived cost as estimates.
 */

/** One prompt turn extracted from a persisted transcript.
 *  Mirrors `TurnStat` in src-tauri/src/history_file.rs. */
export interface TurnStat {
  readonly sentAt: number;
  readonly mode: string;
  readonly permission: string;
  readonly model?: string;
  readonly effort?: string;
  /** Leading slash command, e.g. "/review". */
  readonly command?: string;
  readonly durationMs?: number;
  /** Context-usage delta; absent when unknown or a compaction shrank it. */
  readonly tokens?: number;
  readonly tokensEstimated?: boolean;
  /** Only recorded when not a plain "end_turn". */
  readonly stopReason?: string;
  /** toolKind (read|edit|execute|...) -> calls attributed to this turn. */
  readonly toolCounts: Readonly<Record<string, number>>;
}

/** One session file's extracted stats.
 *  Mirrors `SessionStats` in src-tauri/src/history_file.rs. */
export interface SessionStats {
  readonly sessionId: string;
  /** The provider's own conversation id, when the transcript recorded
   *  one. `sessionId` is local to us; only this can be matched against
   *  the vendor's session log to read billed token usage. */
  readonly providerSessionId?: string;
  /** First prompt, truncated — names the session in cost rankings. */
  readonly title: string;
  /** Known project path — embedded in the transcript or recovered by
   *  hashing the open tabs' paths. Absent for closed projects. */
  readonly projectPath?: string;
  /** Stable fallback grouping key (the session dir name). */
  readonly projectDirHash: string;
  readonly provider: string;
  readonly savedAt: number;
  readonly turns: readonly TurnStat[];
  /** File path -> times touched by tool calls in this session. */
  readonly touchedFiles: Readonly<Record<string, number>>;
}

export type InsightsRange = "7d" | "30d" | "all";

export interface InsightsOptions {
  readonly range: InsightsRange;
  /** Injected clock (epoch ms) so aggregation is deterministic. */
  readonly now: number;
  /** 0..1 fraction from AppSettings.autoCompactThreshold. */
  readonly autoCompactThreshold: number;
  /**
   * Ground truth from the vendors' own logs, when available. Requests
   * are matched to sessions by `SessionStats.providerSessionId` and
   * filtered by their OWN timestamp — not by turn metadata, which older
   * transcripts often lack entirely.
   */
  readonly billed?: readonly BilledRequest[];
  /** Local-date bucketing, injectable for timezone-stable tests. */
  readonly dayKey?: (epochMs: number) => string;
  readonly hourOf?: (epochMs: number) => number;
  readonly weekdayOf?: (epochMs: number) => number;
}

export interface DayCount {
  readonly day: string;
  readonly turns: number;
  readonly sessions: number;
}

export interface ProjectRow {
  readonly key: string;
  /** Last path segment for known projects; "Closed project" otherwise. */
  readonly label: string;
  readonly turns: number;
  readonly agentTimeMs: number;
  readonly tokens: number;
}

export interface ModelRow {
  readonly model: string;
  readonly provider: string;
  readonly tokens: number;
  readonly turns: number;
  readonly costUsd: number | null;
}

export interface BilledSessionRow {
  readonly sessionId: string;
  readonly label: string;
  readonly costUsd: number;
}

export interface BilledModelRow {
  readonly model: string;
  readonly provider: string;
  readonly requests: number;
  readonly tokens: BilledTokens;
  readonly costUsd: number;
}

/** Exact spend, as reported by the vendors themselves. */
export interface BilledSpend {
  readonly costUsd: number;
  readonly tokens: BilledTokens;
  /** 0..1; null when nothing was billed on the input side. */
  readonly cacheHitRate: number | null;
  /**
   * Where the money went. `cacheWrite` is the price of every broken
   * prefix (agent restart, model switch, compaction) and is the segment
   * worth minimising; `cacheRead` is what a healthy long session looks
   * like. Split by COST, not tokens: cache reads dominate any token
   * count while costing a tenth of the rate, so a token split would
   * point at the wrong thing.
   */
  readonly costByKind: {
    readonly input: number;
    readonly output: number;
    readonly cacheWrite: number;
    readonly cacheRead: number;
  };
  /** Spend on subagent traffic, which no top-level turn accounts for. */
  readonly sidechainCostUsd: number;
  readonly bySession: readonly BilledSessionRow[];
  readonly byModel: readonly BilledModelRow[];
  readonly days: readonly { readonly day: string; readonly costUsd: number }[];
  /** Sessions in range whose exact cost is known. */
  readonly billedSessions: number;
  /** Sessions in range still on the estimate — drives the "≈" marker. */
  readonly estimatedSessions: number;
}

export interface InsightsReport {
  /** 0 => the UI renders the empty state. */
  readonly totalTurns: number;
  readonly activity: {
    readonly days: readonly DayCount[];
    readonly totalSessions: number;
    readonly totalAgentTimeMs: number;
    readonly avgTurnDurationMs: number | null;
    /** 24 buckets, local time. */
    readonly byHour: readonly number[];
    /** 7 buckets, Sun..Sat. */
    readonly byWeekday: readonly number[];
    readonly byProject: readonly ProjectRow[];
  };
  readonly tokens: {
    readonly days: readonly { readonly day: string; readonly tokens: number }[];
    readonly total: number;
    /** Fraction of token-bearing turns flagged as estimates. */
    readonly estimatedShare: number;
    readonly avgPerTurn: number | null;
    readonly byModel: readonly ModelRow[];
    readonly byProvider: readonly {
      readonly provider: string;
      readonly tokens: number;
    }[];
    /** Sum over models with known pricing; null when none are known. */
    readonly estimatedCostUsd: number | null;
    /** Turns whose command was a provider's compact command. */
    readonly compactionTurns: number;
    /** Sessions whose cumulative delta crossed threshold × contextWindow. */
    readonly sessionsNearThreshold: number;
  };
  /**
   * Exact spend from the vendors' own logs. Absent when no session in
   * range has a readable one — the UI then shows only the estimate.
   * Never replaces `tokens` above: the two coexist because a range can
   * hold both kinds of session, and conflating them would hide which
   * numbers are real.
   */
  readonly billed?: BilledSpend;
  readonly habits: {
    readonly commands: readonly { readonly command: string; readonly count: number }[];
    readonly modeSplit: Readonly<Record<string, number>>;
    readonly permissionSplit: Readonly<Record<string, number>>;
    readonly effortSplit: Readonly<Record<string, number>>;
    /** Turns stopped with "cancelled" over all turns. */
    readonly cancelledRate: number;
    readonly abnormalStops: Readonly<Record<string, number>>;
  };
  readonly tools: {
    readonly totalsByKind: Readonly<Record<string, number>>;
    readonly avgPerTurnByKind: Readonly<Record<string, number>>;
    readonly topFiles: readonly { readonly path: string; readonly touches: number }[];
  };
}

const DAY_MS = 86_400_000;
const RANGE_MS: Readonly<Record<InsightsRange, number>> = {
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  all: Number.POSITIVE_INFINITY,
};
/** The "all" heatmap covers at most a year of day buckets. */
const MAX_ALL_DAYS = 365;
const COMPACT_COMMANDS = new Set<string>(Object.values(COMPACT_COMMAND));

function localDayKey(epochMs: number): string {
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/).filter((p) => p.length > 0);
  return parts[parts.length - 1] ?? path;
}

function contextWindowOf(provider: string): number | undefined {
  return PROVIDERS.find((p) => p.id === provider)?.contextWindow;
}

/**
 * Exact spend for the range, or undefined when no session in it has a
 * vendor log to read.
 *
 * Deliberately independent of turn filtering: billed requests carry
 * their own timestamps, and many older transcripts have no per-turn
 * metadata at all. Filtering these by turns would drop real spend.
 */
function buildBilledSpend(
  sessions: readonly SessionStats[],
  requests: readonly BilledRequest[],
  cutoff: number,
  dayKey: (epochMs: number) => string,
): BilledSpend | undefined {
  const sessionOf = new Map<string, SessionStats>();
  for (const session of sessions) {
    if (session.providerSessionId) sessionOf.set(session.providerSessionId, session);
  }
  const inRange = requests.filter(
    (r) => r.timestampMs >= cutoff && sessionOf.has(r.sessionId),
  );
  if (inRange.length === 0) return undefined;

  const costOf = (request: BilledRequest): number => {
    const session = sessionOf.get(request.sessionId);
    return billedCostUsd(request, session?.provider ?? "claude", request.model) ?? 0;
  };

  const sessionRows = new Map<string, { label: string; costUsd: number }>();
  const modelRows = new Map<
    string,
    { model: string; provider: string; requests: number; tokens: BilledTokens }
  >();
  const dayCost = new Map<string, number>();
  const costByKind = { input: 0, output: 0, cacheWrite: 0, cacheRead: 0 };
  let costUsd = 0;
  let sidechainCostUsd = 0;

  for (const request of inRange) {
    const session = sessionOf.get(request.sessionId);
    const provider = session?.provider ?? "claude";
    const cost = costOf(request);
    costUsd += cost;
    if (request.isSidechain) sidechainCostUsd += cost;
    // Each bucket priced on its own, so the waste is legible as money.
    const bucket = (tokens: Partial<BilledTokens>) =>
      billedCostUsd({ ...NO_BILLED_TOKENS, ...tokens }, provider, request.model) ?? 0;
    costByKind.input += bucket({ inputTokens: request.inputTokens });
    costByKind.output += bucket({ outputTokens: request.outputTokens });
    costByKind.cacheWrite += bucket({
      cacheWrite5mTokens: request.cacheWrite5mTokens,
      cacheWrite1hTokens: request.cacheWrite1hTokens,
    });
    costByKind.cacheRead += bucket({ cacheReadTokens: request.cacheReadTokens });

    const sessionRow = sessionRows.get(request.sessionId) ?? {
      label: session?.title ?? "Untitled",
      costUsd: 0,
    };
    sessionRow.costUsd += cost;
    sessionRows.set(request.sessionId, sessionRow);

    const modelKey = `${provider}|${request.model}`;
    const modelRow = modelRows.get(modelKey) ?? {
      model: request.model,
      provider,
      requests: 0,
      tokens: NO_BILLED_TOKENS,
    };
    modelRow.requests += 1;
    modelRow.tokens = addBilled(modelRow.tokens, request);
    modelRows.set(modelKey, modelRow);

    const day = dayKey(request.timestampMs);
    dayCost.set(day, (dayCost.get(day) ?? 0) + cost);
  }

  const billedSessionIds = new Set(inRange.map((r) => r.sessionId));
  const tokens = sumBilled(inRange);
  return {
    costUsd,
    tokens,
    cacheHitRate: cacheHitRate(tokens),
    costByKind,
    sidechainCostUsd,
    bySession: [...sessionRows.entries()]
      .map(([sessionId, row]) => ({ sessionId, ...row }))
      .sort((a, b) => b.costUsd - a.costUsd),
    byModel: [...modelRows.values()]
      .map((row) => ({
        ...row,
        costUsd: billedCostUsd(row.tokens, row.provider, row.model) ?? 0,
      }))
      .sort((a, b) => b.costUsd - a.costUsd),
    days: [...dayCost.entries()]
      .map(([day, cost]) => ({ day, costUsd: cost }))
      .sort((a, b) => a.day.localeCompare(b.day)),
    billedSessions: billedSessionIds.size,
    estimatedSessions: sessions.filter(
      (s) => !s.providerSessionId || !billedSessionIds.has(s.providerSessionId),
    ).length,
  };
}

export function buildInsights(
  sessions: readonly SessionStats[],
  options: InsightsOptions,
): InsightsReport {
  const dayKey = options.dayKey ?? localDayKey;
  const hourOf = options.hourOf ?? ((ms: number) => new Date(ms).getHours());
  const weekdayOf = options.weekdayOf ?? ((ms: number) => new Date(ms).getDay());
  const cutoff = options.now - RANGE_MS[options.range];
  const inRange = (t: TurnStat) => t.sentAt >= cutoff;

  // Sessions restricted to their in-range turns; empty ones drop out.
  const included = sessions
    .map((s) => ({ session: s, turns: s.turns.filter(inRange) }))
    .filter((s) => s.turns.length > 0);
  const allTurns = included.flatMap((s) => s.turns);
  const totalTurns = allTurns.length;

  // --- Activity ---------------------------------------------------------
  const dayTurns = new Map<string, number>();
  const daySessions = new Map<string, Set<string>>();
  const byHour = new Array<number>(24).fill(0);
  const byWeekday = new Array<number>(7).fill(0);
  let totalAgentTimeMs = 0;
  let durationCount = 0;

  for (const { session, turns } of included) {
    for (const turn of turns) {
      const key = dayKey(turn.sentAt);
      dayTurns.set(key, (dayTurns.get(key) ?? 0) + 1);
      const set = daySessions.get(key) ?? new Set<string>();
      set.add(session.sessionId);
      daySessions.set(key, set);
      byHour[hourOf(turn.sentAt) % 24] += 1;
      byWeekday[weekdayOf(turn.sentAt) % 7] += 1;
      if (turn.durationMs !== undefined) {
        totalAgentTimeMs += turn.durationMs;
        durationCount += 1;
      }
    }
  }

  const days = buildDaySeries(options.range, options.now, dayKey, allTurns).map(
    (day) => ({
      day,
      turns: dayTurns.get(day) ?? 0,
      sessions: daySessions.get(day)?.size ?? 0,
    }),
  );

  const projects = new Map<
    string,
    { label: string; turns: number; agentTimeMs: number; tokens: number }
  >();
  for (const { session, turns } of included) {
    const key = session.projectPath ?? `#${session.projectDirHash}`;
    const row = projects.get(key) ?? {
      label: session.projectPath ? basename(session.projectPath) : "Closed project",
      turns: 0,
      agentTimeMs: 0,
      tokens: 0,
    };
    for (const turn of turns) {
      row.turns += 1;
      row.agentTimeMs += turn.durationMs ?? 0;
      row.tokens += turn.tokens ?? 0;
    }
    projects.set(key, row);
  }
  const byProject: ProjectRow[] = [...projects.entries()]
    .map(([key, row]) => ({ key, ...row }))
    .sort((a, b) => b.turns - a.turns || a.label.localeCompare(b.label));

  // --- Tokens -----------------------------------------------------------
  const dayTokens = new Map<string, number>();
  const models = new Map<
    string,
    { model: string; provider: string; tokens: number; turns: number }
  >();
  const providerTokens = new Map<string, number>();
  let tokenTotal = 0;
  let tokenBearing = 0;
  let estimatedCount = 0;
  let compactionTurns = 0;

  for (const { session, turns } of included) {
    for (const turn of turns) {
      if (turn.command !== undefined && COMPACT_COMMANDS.has(turn.command)) {
        compactionTurns += 1;
      }
      if (turn.tokens === undefined) continue;
      tokenTotal += turn.tokens;
      tokenBearing += 1;
      if (turn.tokensEstimated) estimatedCount += 1;
      const key = dayKey(turn.sentAt);
      dayTokens.set(key, (dayTokens.get(key) ?? 0) + turn.tokens);
      const modelKey = `${session.provider}|${turn.model ?? ""}`;
      const row = models.get(modelKey) ?? {
        model: turn.model ?? "default",
        provider: session.provider,
        tokens: 0,
        turns: 0,
      };
      row.tokens += turn.tokens;
      row.turns += 1;
      models.set(modelKey, row);
      providerTokens.set(
        session.provider,
        (providerTokens.get(session.provider) ?? 0) + turn.tokens,
      );
    }
  }

  const byModel: ModelRow[] = [...models.values()]
    .map((row) => ({
      ...row,
      costUsd: estimateCostUsd(
        row.tokens,
        row.provider,
        row.model === "default" ? undefined : row.model,
      ),
    }))
    .sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model));
  const knownCosts = byModel.filter((r) => r.costUsd !== null);
  const estimatedCostUsd =
    knownCosts.length > 0
      ? knownCosts.reduce((sum, r) => sum + (r.costUsd ?? 0), 0)
      : null;

  let sessionsNearThreshold = 0;
  for (const { session } of included) {
    const window = contextWindowOf(session.provider);
    if (window === undefined) continue;
    const ceiling = options.autoCompactThreshold * window;
    let cumulative = 0;
    // Session fill is a property of the whole session, not just the
    // range-filtered turns.
    for (const turn of [...session.turns].sort((a, b) => a.sentAt - b.sentAt)) {
      cumulative += turn.tokens ?? 0;
      if (cumulative >= ceiling) {
        sessionsNearThreshold += 1;
        break;
      }
    }
  }

  // --- Habits -----------------------------------------------------------
  const commands = new Map<string, number>();
  const modeSplit: Record<string, number> = {};
  const permissionSplit: Record<string, number> = {};
  const effortSplit: Record<string, number> = {};
  const abnormalStops: Record<string, number> = {};
  let cancelled = 0;

  for (const turn of allTurns) {
    if (turn.command !== undefined) {
      commands.set(turn.command, (commands.get(turn.command) ?? 0) + 1);
    }
    modeSplit[turn.mode] = (modeSplit[turn.mode] ?? 0) + 1;
    permissionSplit[turn.permission] = (permissionSplit[turn.permission] ?? 0) + 1;
    const effort = turn.effort ?? "default";
    effortSplit[effort] = (effortSplit[effort] ?? 0) + 1;
    if (turn.stopReason !== undefined) {
      abnormalStops[turn.stopReason] = (abnormalStops[turn.stopReason] ?? 0) + 1;
      if (turn.stopReason === "cancelled") cancelled += 1;
    }
  }

  // --- Tools ------------------------------------------------------------
  const totalsByKind: Record<string, number> = {};
  for (const turn of allTurns) {
    for (const [kind, count] of Object.entries(turn.toolCounts)) {
      totalsByKind[kind] = (totalsByKind[kind] ?? 0) + count;
    }
  }
  const avgPerTurnByKind: Record<string, number> = {};
  if (totalTurns > 0) {
    for (const [kind, total] of Object.entries(totalsByKind)) {
      avgPerTurnByKind[kind] = total / totalTurns;
    }
  }
  const files = new Map<string, number>();
  for (const { session } of included) {
    for (const [path, touches] of Object.entries(session.touchedFiles)) {
      files.set(path, (files.get(path) ?? 0) + touches);
    }
  }
  const topFiles = [...files.entries()]
    .map(([path, touches]) => ({ path, touches }))
    .sort((a, b) => b.touches - a.touches || a.path.localeCompare(b.path))
    .slice(0, 10);

  return {
    totalTurns,
    activity: {
      days,
      totalSessions: included.length,
      totalAgentTimeMs,
      avgTurnDurationMs: durationCount > 0 ? totalAgentTimeMs / durationCount : null,
      byHour,
      byWeekday,
      byProject,
    },
    tokens: {
      days: days.map(({ day }) => ({ day, tokens: dayTokens.get(day) ?? 0 })),
      total: tokenTotal,
      estimatedShare: tokenBearing > 0 ? estimatedCount / tokenBearing : 0,
      avgPerTurn: tokenBearing > 0 ? tokenTotal / tokenBearing : null,
      byModel,
      byProvider: [...providerTokens.entries()]
        .map(([provider, tokens]) => ({ provider, tokens }))
        .sort((a, b) => b.tokens - a.tokens),
      estimatedCostUsd,
      compactionTurns,
      sessionsNearThreshold,
    },
    billed: buildBilledSpend(sessions, options.billed ?? [], cutoff, dayKey),
    habits: {
      commands: [...commands.entries()]
        .map(([command, count]) => ({ command, count }))
        .sort((a, b) => b.count - a.count || a.command.localeCompare(b.command)),
      modeSplit,
      permissionSplit,
      effortSplit,
      cancelledRate: totalTurns > 0 ? cancelled / totalTurns : 0,
      abnormalStops,
    },
    tools: { totalsByKind, avgPerTurnByKind, topFiles },
  };
}

/**
 * Ordered, gap-filled day keys for the range: exactly N buckets for
 * 7d/30d; for "all", from the first activity day to now (capped at a
 * year). Deduped via Map so a DST-doubled local day can't repeat.
 */
function buildDaySeries(
  range: InsightsRange,
  now: number,
  dayKey: (epochMs: number) => string,
  turns: readonly TurnStat[],
): string[] {
  let count: number;
  if (range === "all") {
    if (turns.length === 0) return [];
    const earliest = Math.min(...turns.map((t) => t.sentAt));
    count = Math.min(MAX_ALL_DAYS, Math.floor((now - earliest) / DAY_MS) + 1);
  } else {
    count = RANGE_MS[range] / DAY_MS;
  }
  const keys = new Map<string, true>();
  for (let i = count - 1; i >= 0; i -= 1) {
    keys.set(dayKey(now - i * DAY_MS), true);
  }
  return [...keys.keys()];
}
