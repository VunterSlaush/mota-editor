import {
  addBilled,
  type BilledRequest,
  type BilledTokens,
  cacheHitRate,
  NO_BILLED_TOKENS,
  sumBilled,
  totalBilledTokens,
} from "./billing";
import { billedCostUsd, estimateCostUsd } from "./modelPricing";
import { COMPACT_COMMAND, contextWindowFor, PROVIDERS } from "./provider";

/**
 * Entities layer — historical usage statistics ("Insights") built from
 * persisted transcripts. Pure aggregation: no React, no Tauri, no IO.
 *
 * Two kinds of token figure live here and must not be confused:
 *
 * - CONTEXT-WINDOW DELTAS per turn (what ACP reports) — how much the
 *   window GREW. This is `TurnStat.tokens`, and it drives `total`,
 *   `byModel`, `byProvider` and every cost derived from them, all of
 *   which displays must mark as estimates.
 * - BILLED tokens from the vendor's own log — how much was actually
 *   SENT, re-sent context included. Exact, and never marked.
 *
 * `billedSpend`, `byCommand` and `coldStarts` prefer the billed figure
 * and fall back to the delta, carrying an `estimated` flag that says
 * which one a row ended up using.
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
  /** Sub-agent the command was handed to; absent when it ran in the chat. */
  readonly agent?: string;
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

export type InsightsRange = "today" | "7d" | "30d" | "all";

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
  /**
   * Midnight that starts the local day containing `epochMs`. "Today"
   * means the calendar day, not the last 24 hours — the difference shows
   * at 09:00, when a rolling window would still be counting yesterday
   * evening's work as today's.
   */
  readonly startOfDay?: (epochMs: number) => number;
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

/** One command's runs and spend on one side of the delegation choice. */
export interface CommandSplit {
  readonly turns: number;
  readonly tokens: number;
}

/** One slash command's total token spend. */
export interface CommandTokenRow {
  readonly command: string;
  readonly turns: number;
  readonly tokens: number;
  /** True when any contributing turn had no vendor log to read. */
  readonly estimated: boolean;
  /** Runs handed to a sub-agent. */
  readonly delegated: CommandSplit;
  /** Runs that stayed in the conversation. */
  readonly inChat: CommandSplit;
}

/**
 * How much a run of this command saves by being delegated, as a fraction
 * of what the same command costs in the chat (0.9 = 90% cheaper). A
 * negative number is a real answer: delegating can cost MORE for a
 * command that adds little context, because the child pays its own cold
 * start.
 *
 * Null when the comparison would be dishonest — nothing measured on one
 * side, or nothing spent in the chat to compare against. Sample sizes
 * are deliberately not judged here: the caller shows the run counts
 * next to this, so the number is never read without them.
 */
export function delegationSaving(row: CommandTokenRow): number | null {
  if (row.delegated.turns === 0 || row.inChat.turns === 0) return null;
  const inChatPerRun = row.inChat.tokens / row.inChat.turns;
  if (inChatPerRun <= 0) return null;
  const delegatedPerRun = row.delegated.tokens / row.delegated.turns;
  return (inChatPerRun - delegatedPerRun) / inChatPerRun;
}

/**
 * What it costs to OPEN a conversation in one project.
 *
 * The first turn of a chat pays for everything the agent has to be told
 * before it can help: the system prompt, every tool schema, and whatever
 * CLAUDE.md/AGENTS.md the project carries. Every new chat there pays it
 * again, which makes it the one token cost that a project can actually
 * be edited to reduce.
 */
export interface ColdStartRow {
  readonly key: string;
  readonly label: string;
  /** Conversations started here in range. */
  readonly conversations: number;
  readonly tokens: number;
  /** The actionable figure: what one new chat here costs. */
  readonly avgTokens: number;
  readonly estimated: boolean;
}

/** Turns grouped by how deep into their conversation they were. */
export interface GrowthBand {
  /** Display label for the range of turn positions, e.g. "11-25". */
  readonly band: string;
  readonly turns: number;
  readonly tokens: number;
  readonly avgTokens: number;
}

/**
 * How a conversation's cost grows as it runs on.
 *
 * Every turn re-sends the whole conversation, so length compounds: the
 * hundredth turn pays for the ninety-nine before it. This is the shape
 * behind most of the bill, and the only thing that resets it is starting
 * a new chat — which is why it is worth showing rather than inferring.
 */
export interface ConversationGrowth {
  readonly byPosition: readonly GrowthBand[];
  readonly avgTurnsPerConversation: number;
  /** Turn position past which spend is counted as "late". */
  readonly lateTurn: number;
  /** Share of all tokens spent in turns past `lateTurn`, 0..1. */
  readonly lateShare: number;
  /** A late turn's average cost over an early one; null when either
   *  end of the curve has no turns to compare. */
  readonly lateMultiple: number | null;
  /** True when any contributing turn fell back to the estimate. */
  readonly estimated: boolean;
}

export interface BilledModelRow {
  readonly model: string;
  readonly provider: string;
  readonly requests: number;
  readonly tokens: BilledTokens;
  readonly costUsd: number;
}

/** One vendor's share of the bill — "what has Claude cost me". */
export interface BilledProviderRow {
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
  /** Dearest vendor first. Summed from the same requests as `costUsd`,
   *  so the rows always add up to the total. */
  readonly byProvider: readonly BilledProviderRow[];
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
    /** Slash commands by total tokens, dearest first. */
    readonly byCommand: readonly CommandTokenRow[];
    /** Projects by what starting a conversation there costs. */
    readonly coldStarts: readonly ColdStartRow[];
  };
  /** What conversation length does to the bill. */
  readonly growth: ConversationGrowth;
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
  // "today" is bounded by the calendar, not by a duration — see
  // `rangeCutoff`. The day's worth here is only what the chart needs.
  today: DAY_MS,
  "7d": 7 * DAY_MS,
  "30d": 30 * DAY_MS,
  all: Number.POSITIVE_INFINITY,
};

/** The earliest `sentAt` a range includes. */
function rangeCutoff(
  range: InsightsRange,
  now: number,
  startOfDay: (epochMs: number) => number,
): number {
  return range === "today" ? startOfDay(now) : now - RANGE_MS[range];
}

function localStartOfDay(epochMs: number): number {
  const date = new Date(epochMs);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}
/** The "all" heatmap covers at most a year of day buckets. */
const MAX_ALL_DAYS = 365;

/**
 * Turn-position buckets for the growth curve, by zero-based index.
 * Widening bands: what matters is the shape, and a long conversation has
 * far more late turns than early ones.
 */
const GROWTH_BANDS: readonly { readonly label: string; readonly upTo: number }[] = [
  { label: "1-10", upTo: 10 },
  { label: "11-25", upTo: 25 },
  { label: "26-50", upTo: 50 },
  { label: "51-100", upTo: 100 },
  { label: "100+", upTo: Number.POSITIVE_INFINITY },
];

/** Turns from here on are "late" — where re-sent history dominates. */
const LATE_TURN = 25;
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

function contextWindowOf(
  provider: string,
  model: string | undefined,
): number | undefined {
  const known = PROVIDERS.find((p) => p.id === provider)?.id;
  return known === undefined ? undefined : contextWindowFor(known, model);
}

/** How a session's project is keyed and named in every ranking. */
function projectIdentity(session: SessionStats): { key: string; label: string } {
  return {
    key: session.projectPath ?? `#${session.projectDirHash}`,
    label: session.projectPath ? basename(session.projectPath) : "Closed project",
  };
}

/** What one turn really cost, and whether that number is a guess. */
interface TurnTokens {
  readonly tokens: number;
  readonly estimated: boolean;
}

/**
 * When a turn stopped being able to spend anything.
 *
 * `durationMs` is stamped at completion as `now - sentAt`, so it bounds
 * the turn exactly: every request the turn made happened inside it. When
 * a transcript predates that stamp, the next turn bounds it instead, and
 * the last turn is bounded by the transcript's own last save — nothing
 * we recorded happened after it.
 */
function turnEnd(ordered: readonly TurnStat[], i: number, savedAt: number): number {
  const turn = ordered[i];
  const bound = Math.min(
    ordered[i + 1]?.sentAt ?? Number.POSITIVE_INFINITY,
    turn.durationMs !== undefined
      ? turn.sentAt + turn.durationMs
      : Number.POSITIVE_INFINITY,
  );
  return Number.isFinite(bound) ? bound : savedAt;
}

/**
 * Tokens each of a session's turns actually cost, keyed by turn.
 *
 * Billed requests carry a timestamp but no turn, so each is credited to
 * the most recent turn already under way when it was made — within a
 * session turns run one at a time, which makes that exact. Requests
 * predating the first turn are credited to it: they ARE the startup.
 *
 * A request made outside every turn's own window is credited to NONE of
 * them. One provider session can outlive the transcript that recorded
 * part of it — resumed from the vendor's own CLI, split across chats,
 * continued after we stopped writing turns — and letting the last turn
 * absorb the remainder is what made a one-line local command like
 * `/usage` claim a whole conversation's spend. The exact total is not
 * lost: `buildBilledSpend` counts every request in range on its own.
 *
 * Falls back to the per-turn context delta when the session has no
 * vendor log, or no usable turn clock to line one up against — a
 * ranking that silently dropped those sessions would mislead worse than
 * one that marks them estimated.
 */
function tokensPerTurn(
  session: SessionStats,
  billed: readonly BilledRequest[],
): Map<TurnStat, TurnTokens> {
  const ordered = [...session.turns].sort((a, b) => a.sentAt - b.sentAt);
  const estimate = (): Map<TurnStat, TurnTokens> =>
    new Map(ordered.map((t) => [t, { tokens: t.tokens ?? 0, estimated: true }]));
  if (ordered.length === 0) return new Map();

  const mine = session.providerSessionId
    ? billed.filter((r) => r.sessionId === session.providerSessionId)
    : [];
  // A turn with no clock (transcripts predating turn stats) cannot be
  // lined up against a timestamp; guessing would pile the whole session
  // onto its last turn.
  if (mine.length === 0 || ordered.some((t) => t.sentAt <= 0)) return estimate();

  const ends = ordered.map((_, i) => turnEnd(ordered, i, session.savedAt));
  const totals = ordered.map(() => 0);
  let index = 0;
  for (const request of [...mine].sort((a, b) => a.timestampMs - b.timestampMs)) {
    while (
      index + 1 < ordered.length &&
      ordered[index + 1].sentAt <= request.timestampMs
    ) {
      index += 1;
    }
    // Only the END is bounded: a request predating the first turn is
    // still that turn's startup, but one made after a turn finished
    // belongs to work this transcript never saw.
    if (request.timestampMs > ends[index]) continue;
    totals[index] += totalBilledTokens(request);
  }
  return new Map(ordered.map((t, i) => [t, { tokens: totals[i], estimated: false }]));
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
  const providerRows = new Map<
    string,
    { requests: number; tokens: BilledTokens; costUsd: number }
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

    const providerRow = providerRows.get(provider) ?? {
      requests: 0,
      tokens: NO_BILLED_TOKENS,
      costUsd: 0,
    };
    providerRow.requests += 1;
    providerRow.tokens = addBilled(providerRow.tokens, request);
    // Summed per request rather than repriced from the provider's total:
    // one vendor can bill several models at different rates.
    providerRow.costUsd += cost;
    providerRows.set(provider, providerRow);

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
    byProvider: [...providerRows.entries()]
      .map(([provider, row]) => ({ provider, ...row }))
      .sort((a, b) => b.costUsd - a.costUsd || a.provider.localeCompare(b.provider)),
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
  const startOfDay = options.startOfDay ?? localStartOfDay;
  const cutoff = rangeCutoff(options.range, options.now, startOfDay);
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

  // --- What the tokens were spent ON ------------------------------------
  // Both rankings are in TOKENS, and both prefer the vendor's billed
  // count over the context delta: a turn's delta says how much the
  // window grew, not how much was sent, and re-sent context is most of
  // what a turn costs.
  const billedRequests = options.billed ?? [];
  const commandTokens = new Map<
    string,
    {
      turns: number;
      tokens: number;
      estimated: boolean;
      delegated: { turns: number; tokens: number };
      inChat: { turns: number; tokens: number };
    }
  >();
  const coldStarts = new Map<
    string,
    { label: string; conversations: number; tokens: number; estimated: boolean }
  >();

  for (const { session, turns } of included) {
    const measured = tokensPerTurn(session, billedRequests);
    for (const turn of turns) {
      if (turn.command === undefined) continue;
      const cost = measured.get(turn) ?? { tokens: turn.tokens ?? 0, estimated: true };
      const row = commandTokens.get(turn.command) ?? {
        turns: 0,
        tokens: 0,
        estimated: false,
        delegated: { turns: 0, tokens: 0 },
        inChat: { turns: 0, tokens: 0 },
      };
      row.turns += 1;
      row.tokens += cost.tokens;
      row.estimated = row.estimated || cost.estimated;
      // Which side of the delegation choice this run landed on, so the
      // setting can be judged by what it actually did.
      const side = turn.agent ? row.delegated : row.inChat;
      side.turns += 1;
      side.tokens += cost.tokens;
      commandTokens.set(turn.command, row);
    }
  }

  // Cold starts are counted from the session's OWN first turn, and the
  // session is included by when that turn happened — the first in-range
  // turn of an older conversation is not a cold start, it is just a turn.
  for (const session of sessions) {
    const first = [...session.turns].sort((a, b) => a.sentAt - b.sentAt)[0];
    if (!first || !inRange(first)) continue;
    const cost = tokensPerTurn(session, billedRequests).get(first) ?? {
      tokens: first.tokens ?? 0,
      estimated: true,
    };
    const { key, label } = projectIdentity(session);
    const row = coldStarts.get(key) ?? {
      label,
      conversations: 0,
      tokens: 0,
      estimated: false,
    };
    row.conversations += 1;
    row.tokens += cost.tokens;
    row.estimated = row.estimated || cost.estimated;
    coldStarts.set(key, row);
  }

  // --- Conversation growth ----------------------------------------------
  // Position is the turn's place in its OWN conversation, not in the
  // filtered slice: a turn is the fortieth of its chat whether or not the
  // first thirty-nine fall inside the range. Only in-range turns are
  // counted, so this stays a picture of the selected period.
  const bands = GROWTH_BANDS.map((b) => ({ band: b.label, turns: 0, tokens: 0 }));
  let growthEstimated = false;
  let countedTurns = 0;
  let lateTokens = 0;
  let allTokens = 0;

  for (const { session, turns } of included) {
    const measured = tokensPerTurn(session, billedRequests);
    const order = new Map(
      [...session.turns].sort((a, b) => a.sentAt - b.sentAt).map((t, i) => [t, i]),
    );
    const inRangeTurns = new Set(turns);
    for (const [turn, position] of order) {
      if (!inRangeTurns.has(turn)) continue;
      const cost = measured.get(turn) ?? { tokens: turn.tokens ?? 0, estimated: true };
      const band = bands[GROWTH_BANDS.findIndex((b) => position < b.upTo)];
      band.turns += 1;
      band.tokens += cost.tokens;
      growthEstimated = growthEstimated || cost.estimated;
      countedTurns += 1;
      allTokens += cost.tokens;
      if (position >= LATE_TURN) lateTokens += cost.tokens;
    }
  }

  const populated = bands.filter((b) => b.turns > 0);
  const perTurn = (b: (typeof bands)[number]) => b.tokens / b.turns;
  const first = populated[0];
  const last = populated[populated.length - 1];
  const growth: ConversationGrowth = {
    byPosition: populated.map((b) => ({ ...b, avgTokens: perTurn(b) })),
    avgTurnsPerConversation: included.length > 0 ? countedTurns / included.length : 0,
    lateTurn: LATE_TURN,
    lateShare: allTokens > 0 ? lateTokens / allTokens : 0,
    lateMultiple:
      populated.length > 1 && perTurn(first) > 0 ? perTurn(last) / perTurn(first) : null,
    estimated: growthEstimated,
  };

  const byCommand: CommandTokenRow[] = [...commandTokens.entries()]
    .map(([command, row]) => ({ command, ...row }))
    .sort((a, b) => b.tokens - a.tokens || a.command.localeCompare(b.command));

  const coldStartRows: ColdStartRow[] = [...coldStarts.entries()]
    .map(([key, row]) => ({
      key,
      ...row,
      avgTokens: row.tokens / row.conversations,
    }))
    // Ranked by what ONE new chat costs, not by the total: a project
    // worked in all week would otherwise always top a list meant to
    // point at the expensive project, not the busy one.
    .sort((a, b) => b.avgTokens - a.avgTokens || a.label.localeCompare(b.label));

  let sessionsNearThreshold = 0;
  for (const { session } of included) {
    // Judged against the window of the model the session ENDED under —
    // the ceiling that applied when the fill actually accumulated.
    const lastModel = [...session.turns]
      .sort((a, b) => b.sentAt - a.sentAt)
      .find((t) => t.model !== undefined)?.model;
    const window = contextWindowOf(session.provider, lastModel);
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
      byCommand,
      coldStarts: coldStartRows,
    },
    growth,
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
  // One bucket: yesterday is a different day, not the tail of this one.
  if (range === "today") count = 1;
  const keys = new Map<string, true>();
  for (let i = count - 1; i >= 0; i -= 1) {
    keys.set(dayKey(now - i * DAY_MS), true);
  }
  return [...keys.keys()];
}
