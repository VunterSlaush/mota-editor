import { describe, expect, it } from "vitest";
import type { BilledRequest } from "./billing";
import {
  buildInsights,
  delegationReport,
  type InsightsOptions,
  type SessionStats,
  type TurnStat,
} from "./insights";

const DAY = 86_400_000;
const HOUR = 3_600_000;
/** Midnight UTC, so day arithmetic is exact under the injected keys. */
const NOW = 1_000 * DAY;

const utcDayKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const utcStartOfDay = (ms: number) => Math.floor(ms / DAY) * DAY;
const utcHour = (ms: number) => new Date(ms).getUTCHours();
const utcWeekday = (ms: number) => new Date(ms).getUTCDay();

function turn(overrides: Partial<TurnStat> = {}): TurnStat {
  return {
    sentAt: NOW - DAY,
    mode: "normal",
    permission: "default",
    toolCounts: {},
    ...overrides,
  };
}

function session(overrides: Partial<SessionStats> = {}): SessionStats {
  return {
    sessionId: "s1",
    title: "A session",
    projectDirHash: "hash1",
    provider: "claude",
    savedAt: NOW,
    turns: [],
    touchedFiles: {},
    ...overrides,
  };
}

function build(
  sessions: readonly SessionStats[],
  overrides: Partial<InsightsOptions> = {},
) {
  return buildInsights(sessions, {
    range: "30d",
    now: NOW,
    autoCompactThreshold: 0.85,
    dayKey: utcDayKey,
    startOfDay: utcStartOfDay,
    hourOf: utcHour,
    weekdayOf: utcWeekday,
    ...overrides,
  });
}

describe("buildInsights", () => {
  it("produces a zero report for no sessions", () => {
    const report = build([]);
    expect(report.totalTurns).toBe(0);
    expect(report.activity.totalSessions).toBe(0);
    expect(report.activity.avgTurnDurationMs).toBeNull();
    expect(report.activity.days).toHaveLength(30);
    expect(report.activity.days.every((d) => d.turns === 0)).toBe(true);
    expect(report.tokens.total).toBe(0);
    expect(report.tokens.avgPerTurn).toBeNull();
    expect(report.tokens.estimatedCostUsd).toBeNull();
    expect(report.habits.cancelledRate).toBe(0);
    expect(report.tools.topFiles).toEqual([]);
  });

  it("filters turns by range and gap-fills exactly N day buckets", () => {
    const s = session({
      turns: [turn({ sentAt: NOW - 8 * DAY }), turn({ sentAt: NOW - DAY })],
    });
    const week = build([s], { range: "7d" });
    expect(week.totalTurns).toBe(1);
    expect(week.activity.days).toHaveLength(7);

    const month = build([s], { range: "30d" });
    expect(month.totalTurns).toBe(2);
    expect(month.activity.days).toHaveLength(30);
  });

  it("counts today as the calendar day, not the last 24 hours", () => {
    // 09:00. A rolling window would still be counting yesterday evening.
    const morning = NOW + 9 * HOUR;
    const s = session({
      turns: [
        turn({ sentAt: morning - 11 * HOUR }), // yesterday, 22:00
        turn({ sentAt: morning - HOUR }), // today, 08:00
      ],
    });

    const today = build([s], { range: "today", now: morning });

    expect(today.totalTurns).toBe(1);
    expect(today.activity.days).toHaveLength(1);
    expect(today.activity.days[0].day).toBe(utcDayKey(morning));
  });

  it("shows an empty today rather than yesterday's work", () => {
    const s = session({ turns: [turn({ sentAt: NOW - HOUR })] });
    expect(build([s], { range: "today", now: NOW + HOUR }).totalTurns).toBe(0);
  });

  it("drops sessions with no in-range turns from session counts", () => {
    const old = session({ sessionId: "old", turns: [turn({ sentAt: NOW - 40 * DAY })] });
    const fresh = session({ sessionId: "new", turns: [turn()] });
    const report = build([old, fresh]);
    expect(report.activity.totalSessions).toBe(1);
  });

  it("spans all-time day buckets from first activity, capped at a year", () => {
    const s = session({ turns: [turn({ sentAt: NOW - 3 * DAY }), turn()] });
    const report = build([s], { range: "all" });
    expect(report.activity.days).toHaveLength(4);
    expect(report.activity.days[0].day).toBe(utcDayKey(NOW - 3 * DAY));

    const ancient = session({ turns: [turn({ sentAt: NOW - 500 * DAY })] });
    expect(build([ancient], { range: "all" }).activity.days).toHaveLength(365);
  });

  it("counts turns and sessions per day and buckets hours/weekdays", () => {
    const at = NOW - DAY + 9 * 3_600_000; // 09:00 UTC
    const s1 = session({
      sessionId: "a",
      turns: [turn({ sentAt: at }), turn({ sentAt: at + 60_000 })],
    });
    const s2 = session({ sessionId: "b", turns: [turn({ sentAt: at })] });
    const report = build([s1, s2]);
    const day = report.activity.days.find((d) => d.day === utcDayKey(at));
    expect(day).toMatchObject({ turns: 3, sessions: 2 });
    expect(report.activity.byHour[9]).toBe(3);
    expect(report.activity.byWeekday[utcWeekday(at)]).toBe(3);
  });

  it("excludes turns without duration or tokens from averages, not from counts", () => {
    const s = session({
      turns: [
        turn({ durationMs: 10_000, tokens: 500 }),
        turn(), // legacy turn — no completion data
      ],
    });
    const report = build([s]);
    expect(report.totalTurns).toBe(2);
    expect(report.activity.avgTurnDurationMs).toBe(10_000);
    expect(report.tokens.avgPerTurn).toBe(500);
    expect(report.tokens.total).toBe(500);
  });

  it("groups projects by path with basename labels, closed projects by hash", () => {
    const known = session({
      sessionId: "a",
      projectPath: "G:\\work\\mota-editor",
      turns: [turn(), turn()],
    });
    const closed = session({
      sessionId: "b",
      projectDirHash: "deadbeef",
      turns: [turn()],
    });
    const report = build([known, closed]);
    expect(report.activity.byProject).toHaveLength(2);
    expect(report.activity.byProject[0]).toMatchObject({
      label: "mota-editor",
      turns: 2,
    });
    expect(report.activity.byProject[1]).toMatchObject({
      key: "#deadbeef",
      label: "Closed project",
      turns: 1,
    });
  });

  it("computes estimated share over token-bearing turns only", () => {
    const s = session({
      turns: [
        turn({ tokens: 100, tokensEstimated: true }),
        turn({ tokens: 300 }),
        turn(), // no tokens — not part of the share
      ],
    });
    const report = build([s]);
    expect(report.tokens.estimatedShare).toBeCloseTo(0.5);
    expect(report.tokens.total).toBe(400);
  });

  it("breaks tokens down by model with cost, null for unknown models", () => {
    const s = session({
      turns: [
        turn({ tokens: 1_000_000, model: "sonnet" }),
        turn({ tokens: 1_000_000, model: "mystery-model" }),
      ],
    });
    const report = build([s]);
    const sonnet = report.tokens.byModel.find((r) => r.model === "sonnet");
    const mystery = report.tokens.byModel.find((r) => r.model === "mystery-model");
    expect(sonnet?.costUsd).toBeCloseTo(6);
    expect(mystery?.costUsd).toBeNull();
    // Only the known row contributes to the total estimate.
    expect(report.tokens.estimatedCostUsd).toBeCloseTo(6);
  });

  it("nulls the total cost when no model has known pricing", () => {
    const s = session({
      turns: [turn({ tokens: 1_000, model: "mystery-model" })],
    });
    expect(build([s]).tokens.estimatedCostUsd).toBeNull();
  });

  it("prices undefined model at the provider default and buckets it as 'default'", () => {
    const s = session({ turns: [turn({ tokens: 1_000_000 })] });
    const report = build([s]);
    expect(report.tokens.byModel[0]).toMatchObject({
      model: "default",
      provider: "claude",
    });
    expect(report.tokens.byModel[0].costUsd).toBeCloseTo(6);
  });

  it("counts compaction turns for every provider's compact command", () => {
    const claude = session({ turns: [turn({ command: "/compact" })] });
    const gemini = session({
      sessionId: "g",
      provider: "gemini",
      turns: [turn({ command: "/compress" })],
    });
    const report = build([claude, gemini]);
    expect(report.tokens.compactionTurns).toBe(2);
    // Compact commands also appear in the habits command list.
    expect(report.habits.commands.map((c) => c.command)).toEqual(
      expect.arrayContaining(["/compact", "/compress"]),
    );
  });

  it("counts a session once when its cumulative delta crosses the auto-compact ceiling", () => {
    // haiku window 200k × 0.85 = 170k ceiling
    const crossing = session({
      turns: [
        turn({ sentAt: NOW - 2 * DAY, tokens: 100_000, model: "haiku" }),
        turn({ sentAt: NOW - DAY, tokens: 80_000, model: "haiku" }),
        turn({ sentAt: NOW - DAY + 1, tokens: 10_000, model: "haiku" }),
      ],
    });
    const below = session({
      sessionId: "b",
      turns: [turn({ tokens: 50_000, model: "haiku" })],
    });
    const report = build([crossing, below]);
    expect(report.tokens.sessionsNearThreshold).toBe(1);
  });

  it("judges session fill against the window of the model it ended under", () => {
    // 190k would cross a 200k window's ceiling but is 19% of the default
    // claude model's 1M window — near-threshold must not count it.
    const defaultModel = session({
      turns: [turn({ sentAt: NOW - DAY, tokens: 190_000 })],
    });
    expect(build([defaultModel]).tokens.sessionsNearThreshold).toBe(0);

    // The same fill under haiku, switched to mid-session: the LAST model
    // decides, because that is the window the session actually ended in.
    const endedOnHaiku = session({
      turns: [
        turn({ sentAt: NOW - 2 * DAY, tokens: 190_000, model: "sonnet" }),
        turn({ sentAt: NOW - DAY, tokens: 1_000, model: "haiku" }),
      ],
    });
    expect(build([endedOnHaiku]).tokens.sessionsNearThreshold).toBe(1);
  });

  it("splits habits by mode, permission, and effort with a 'default' effort bucket", () => {
    const s = session({
      turns: [
        turn({ mode: "plan", effort: "high" }),
        turn({ mode: "normal" }),
        turn({ mode: "normal", permission: "yolo" }),
      ],
    });
    const report = build([s]);
    expect(report.habits.modeSplit).toEqual({ plan: 1, normal: 2 });
    expect(report.habits.permissionSplit).toEqual({ default: 2, yolo: 1 });
    expect(report.habits.effortSplit).toEqual({ high: 1, default: 2 });
  });

  it("computes cancelled rate and abnormal stop breakdown", () => {
    const s = session({
      turns: [
        turn({ stopReason: "cancelled" }),
        turn({ stopReason: "max_tokens" }),
        turn(),
        turn(),
      ],
    });
    const report = build([s]);
    expect(report.habits.cancelledRate).toBeCloseTo(0.25);
    expect(report.habits.abnormalStops).toEqual({ cancelled: 1, max_tokens: 1 });
  });

  it("totals tool calls by kind with per-turn averages", () => {
    const s = session({
      turns: [
        turn({ toolCounts: { read: 3, edit: 1 } }),
        turn({ toolCounts: { read: 1 } }),
      ],
    });
    const report = build([s]);
    expect(report.tools.totalsByKind).toEqual({ read: 4, edit: 1 });
    expect(report.tools.avgPerTurnByKind.read).toBeCloseTo(2);
    expect(report.tools.avgPerTurnByKind.edit).toBeCloseTo(0.5);
  });

  it("ranks touched files across sessions, capped at ten with stable ties", () => {
    const many = Object.fromEntries(
      Array.from({ length: 12 }, (_, i) => [`file${String(i).padStart(2, "0")}.ts`, 1]),
    );
    const a = session({ turns: [turn()], touchedFiles: { ...many, "hot.ts": 5 } });
    const b = session({ sessionId: "b", turns: [turn()], touchedFiles: { "hot.ts": 2 } });
    const report = build([a, b]);
    expect(report.tools.topFiles).toHaveLength(10);
    expect(report.tools.topFiles[0]).toEqual({ path: "hot.ts", touches: 7 });
    // Equal counts tie-break alphabetically.
    expect(report.tools.topFiles[1].path).toBe("file00.ts");
  });
});

/** A million input tokens on opus — $5 exactly, which keeps sums legible. */
function billed(overrides: Partial<BilledRequest> = {}): BilledRequest {
  return {
    requestId: "r1",
    sessionId: "provider-1",
    timestampMs: NOW - DAY,
    model: "claude-opus-5",
    isSidechain: false,
    inputTokens: 1_000_000,
    outputTokens: 0,
    cacheWrite5mTokens: 0,
    cacheWrite1hTokens: 0,
    cacheReadTokens: 0,
    ...overrides,
  };
}

const logged = session({ providerSessionId: "provider-1", turns: [turn()] });

describe("buildInsights token rankings", () => {
  it("ranks commands by tokens, dearest first", () => {
    const s = session({
      turns: [
        turn({ command: "/review", tokens: 40_000 }),
        turn({ command: "/commit", tokens: 2_000 }),
        turn({ command: "/review", tokens: 20_000 }),
        turn({ tokens: 99_000 }), // no command — not a command cost
      ],
    });
    const rows = build([s]).tokens.byCommand;
    expect(rows.map((r) => r.command)).toEqual(["/review", "/commit"]);
    expect(rows[0]).toMatchObject({ tokens: 60_000, turns: 2 });
  });

  it("prefers the vendor's billed tokens over the context delta", () => {
    // A turn's delta says how much the window GREW; the billed count
    // says how much was sent. Re-sent context is most of what a turn
    // costs, so the two differ by a lot and only one is the truth.
    const s = session({
      providerSessionId: "provider-1",
      turns: [turn({ command: "/review", sentAt: NOW - DAY, tokens: 500 })],
    });
    const report = build([s], {
      billed: [billed({ timestampMs: NOW - DAY + 1_000, inputTokens: 90_000 })],
    });
    expect(report.tokens.byCommand[0]).toMatchObject({
      tokens: 90_000,
      estimated: false,
    });
  });

  it("credits each request to the turn that was running when it was made", () => {
    const s = session({
      providerSessionId: "provider-1",
      turns: [
        turn({ command: "/first", sentAt: NOW - DAY }),
        turn({ command: "/second", sentAt: NOW - DAY + 10_000 }),
      ],
    });
    const report = build([s], {
      billed: [
        // Before any turn started — that IS the first turn's startup.
        billed({ requestId: "r0", timestampMs: NOW - DAY - 5_000, inputTokens: 1_000 }),
        billed({ requestId: "r1", timestampMs: NOW - DAY + 1_000, inputTokens: 2_000 }),
        billed({ requestId: "r2", timestampMs: NOW - DAY + 11_000, inputTokens: 7_000 }),
      ],
    });
    const byCommand = new Map(report.tokens.byCommand.map((r) => [r.command, r.tokens]));
    expect(byCommand.get("/first")).toBe(3_000);
    expect(byCommand.get("/second")).toBe(7_000);
  });

  it("does not let the last turn absorb what the session spent after it", () => {
    // One provider session can outlive the transcript that recorded part
    // of it — resumed from the vendor's CLI, split across chats. A local
    // command that costs nothing was ending up charged for all of it.
    const s = session({
      providerSessionId: "provider-1",
      savedAt: NOW - DAY + 3_000,
      turns: [turn({ command: "/usage", sentAt: NOW - DAY, durationMs: 2_000 })],
    });
    const report = build([s], {
      billed: [
        billed({ requestId: "own", timestampMs: NOW - DAY + 1_000, inputTokens: 400 }),
        // Hours later, under the same provider session, with no turn of
        // ours to account for it.
        billed({
          requestId: "later",
          timestampMs: NOW - DAY + 3_600_000,
          inputTokens: 7_000_000,
        }),
      ],
    });
    expect(report.tokens.byCommand[0]).toMatchObject({ command: "/usage", tokens: 400 });
    // Still counted as spend — it just belongs to no turn we recorded.
    expect(report.billed?.tokens.inputTokens).toBe(7_000_400);
  });

  it("bounds a turn with no duration stamp by the transcript's last save", () => {
    const s = session({
      providerSessionId: "provider-1",
      savedAt: NOW - DAY + 5_000,
      turns: [turn({ command: "/review", sentAt: NOW - DAY })],
    });
    const report = build([s], {
      billed: [
        billed({ requestId: "in", timestampMs: NOW - DAY + 4_000, inputTokens: 900 }),
        billed({ requestId: "out", timestampMs: NOW - DAY + 9_000, inputTokens: 50_000 }),
      ],
    });
    expect(report.tokens.byCommand[0]).toMatchObject({ command: "/review", tokens: 900 });
  });

  it("marks a command estimated when any of its turns had no vendor log", () => {
    const logged = session({
      providerSessionId: "provider-1",
      turns: [turn({ command: "/review", sentAt: NOW - DAY })],
    });
    const unlogged = session({
      sessionId: "s2",
      turns: [turn({ command: "/review", tokens: 100 })],
    });
    const report = build([logged, unlogged], {
      billed: [billed({ timestampMs: NOW - DAY + 1_000, inputTokens: 1_000 })],
    });
    expect(report.tokens.byCommand[0].estimated).toBe(true);
  });

  it("ranks folders by what ONE new chat costs, not by how busy they are", () => {
    // The busy project would win a total; the expensive one should win
    // this, because that is the number a project can be edited to change.
    const busy = session({
      sessionId: "a",
      projectPath: "/work/busy",
      turns: [turn({ tokens: 10_000 })],
    });
    const busyAgain = session({
      sessionId: "b",
      projectPath: "/work/busy",
      turns: [turn({ tokens: 10_000 })],
    });
    const heavy = session({
      sessionId: "c",
      projectPath: "/work/heavy",
      turns: [turn({ tokens: 30_000 })],
    });
    const rows = build([busy, busyAgain, heavy]).tokens.coldStarts;
    expect(rows.map((r) => r.label)).toEqual(["heavy", "busy"]);
    expect(rows[0]).toMatchObject({ avgTokens: 30_000, conversations: 1 });
    expect(rows[1]).toMatchObject({
      avgTokens: 10_000,
      conversations: 2,
      tokens: 20_000,
    });
  });

  it("counts only a conversation's own first turn", () => {
    const s = session({
      projectPath: "/work/alpha",
      turns: [
        turn({ sentAt: NOW - 2 * DAY, tokens: 25_000 }),
        turn({ sentAt: NOW - DAY, tokens: 900 }),
      ],
    });
    expect(build([s]).tokens.coldStarts[0].avgTokens).toBe(25_000);
  });

  it("does not treat an older chat's first in-range turn as a cold start", () => {
    // The conversation began before the range; nothing in it is a start.
    const s = session({
      projectPath: "/work/alpha",
      turns: [
        turn({ sentAt: NOW - 40 * DAY, tokens: 25_000 }),
        turn({ sentAt: NOW - DAY, tokens: 900 }),
      ],
    });
    expect(build([s], { range: "30d" }).tokens.coldStarts).toEqual([]);
  });

  it("keeps closed projects in the ranking under their fallback name", () => {
    const s = session({ projectDirHash: "deadbeef", turns: [turn({ tokens: 5_000 })] });
    expect(build([s]).tokens.coldStarts[0]).toMatchObject({
      key: "#deadbeef",
      label: "Closed project",
    });
  });

  it("falls back to the estimate when turns have no clock to line up against", () => {
    // Transcripts predating turn stats have sentAt 0; attributing by
    // timestamp would pile the whole session onto its last turn.
    const s = session({
      providerSessionId: "provider-1",
      turns: [
        turn({ command: "/review", sentAt: 0, tokens: 300 }),
        turn({ command: "/commit", sentAt: 0, tokens: 100 }),
      ],
    });
    const report = build([s], {
      range: "all",
      billed: [billed({ inputTokens: 50_000 })],
    });
    const byCommand = new Map(report.tokens.byCommand.map((r) => [r.command, r.tokens]));
    expect(byCommand.get("/review")).toBe(300);
    expect(byCommand.get("/commit")).toBe(100);
    expect(report.tokens.byCommand.every((r) => r.estimated)).toBe(true);
  });
});

describe("buildInsights conversation growth", () => {
  /** A session of `count` turns, one per hour, each costing `tokens`. */
  const longChat = (count: number, tokens: (i: number) => number, extra = {}) =>
    session({
      turns: Array.from({ length: count }, (_, i) =>
        turn({ sentAt: NOW - DAY + i * 3_600_000, tokens: tokens(i) }),
      ),
      ...extra,
    });

  it("buckets turns by how deep into the conversation they were", () => {
    const report = build([longChat(30, () => 1_000)], { range: "all" });
    expect(report.growth.byPosition.map((b) => b.band)).toEqual([
      "1-10",
      "11-25",
      "26-50",
    ]);
    expect(report.growth.byPosition.map((b) => b.turns)).toEqual([10, 15, 5]);
  });

  it("shows the curve: a late turn costs more than an early one", () => {
    // The whole point — every turn re-sends the conversation so far.
    const report = build([longChat(30, (i) => 1_000 * (i + 1))], { range: "all" });
    const [early, , late] = report.growth.byPosition;
    expect(late.avgTokens).toBeGreaterThan(early.avgTokens);
    expect(report.growth.lateMultiple).toBeCloseTo(late.avgTokens / early.avgTokens);
  });

  it("takes position from the whole conversation, not the filtered slice", () => {
    // A turn is the 40th of its chat whether or not the first 39 fall in
    // range. Counting position within the range would report a long
    // conversation's late turns as if they were fresh ones.
    const s = session({
      turns: [
        ...Array.from({ length: 30 }, (_, i) =>
          turn({ sentAt: NOW - 40 * DAY + i * 1_000, tokens: 100 }),
        ),
        turn({ sentAt: NOW - DAY, tokens: 9_000 }),
      ],
    });
    const report = build([s], { range: "7d" });
    // Only the last turn is in range, and it sits in the 26-50 band.
    expect(report.growth.byPosition).toHaveLength(1);
    expect(report.growth.byPosition[0]).toMatchObject({ band: "26-50", turns: 1 });
  });

  it("reports the share of tokens spent late in conversations", () => {
    // 10 early turns at 100, 15 late turns at 900.
    const report = build([longChat(25, (i) => (i < 10 ? 100 : 900))], { range: "all" });
    expect(report.growth.lateTurn).toBe(25);
    expect(report.growth.lateShare).toBe(0); // nothing past position 25 yet
    const longer = build([longChat(40, (i) => (i < 25 ? 100 : 900))], { range: "all" });
    expect(longer.growth.lateShare).toBeCloseTo((15 * 900) / (25 * 100 + 15 * 900));
  });

  it("has no multiple to report from a single band", () => {
    // One band means no early-to-late comparison exists; inventing a
    // 1.0x would read as "length is free", which is the opposite.
    const report = build([longChat(5, () => 1_000)], { range: "all" });
    expect(report.growth.byPosition).toHaveLength(1);
    expect(report.growth.lateMultiple).toBeNull();
  });

  it("averages conversation length over the sessions in range", () => {
    const report = build(
      [longChat(10, () => 1), session({ sessionId: "s2", turns: [turn()] })],
      {
        range: "all",
      },
    );
    expect(report.growth.avgTurnsPerConversation).toBeCloseTo(5.5);
  });

  it("prefers billed tokens and marks the curve when it falls back", () => {
    const logged = session({
      providerSessionId: "provider-1",
      turns: [turn({ sentAt: NOW - DAY })],
    });
    const billedReport = build([logged], {
      billed: [billed({ timestampMs: NOW - DAY + 1_000, inputTokens: 70_000 })],
    });
    expect(billedReport.growth.byPosition[0].tokens).toBe(70_000);
    expect(billedReport.growth.estimated).toBe(false);

    expect(build([longChat(3, () => 500)]).growth.estimated).toBe(true);
  });

  it("is empty rather than broken when nothing is in range", () => {
    const report = build([]);
    expect(report.growth.byPosition).toEqual([]);
    expect(report.growth.lateMultiple).toBeNull();
    expect(report.growth.lateShare).toBe(0);
    expect(report.growth.avgTurnsPerConversation).toBe(0);
  });
});

describe("buildInsights billed spend", () => {
  it("is absent when no vendor log covers the range", () => {
    expect(build([logged]).billed).toBeUndefined();
  });

  it("keeps the estimate alongside the exact figure, never replacing it", () => {
    // Both must survive: a range can hold sessions of both kinds, and
    // collapsing them would hide which numbers are real.
    const report = build(
      [session({ providerSessionId: "provider-1", turns: [turn({ tokens: 500 })] })],
      {
        billed: [billed()],
      },
    );
    expect(report.billed?.costUsd).toBeCloseTo(5);
    expect(report.tokens.total).toBe(500);
  });

  it("ignores requests belonging to sessions it was not given", () => {
    const report = build([logged], { billed: [billed({ sessionId: "someone-else" })] });
    expect(report.billed).toBeUndefined();
  });

  it("ignores requests older than the range", () => {
    const report = build([logged], {
      range: "7d",
      billed: [billed({ timestampMs: NOW - 30 * DAY })],
    });
    expect(report.billed).toBeUndefined();
  });

  it("counts sessions with no vendor log as estimated", () => {
    const report = build([logged, session({ sessionId: "s2", turns: [turn()] })], {
      billed: [billed()],
    });
    expect(report.billed?.billedSessions).toBe(1);
    expect(report.billed?.estimatedSessions).toBe(1);
  });

  it("prices cache writes separately so respawn waste is legible", () => {
    const report = build([logged], {
      billed: [billed({ inputTokens: 0, cacheWrite1hTokens: 1_000_000 })],
    });
    // 1M cache-write-1h on opus = $5 input rate x 2.0.
    expect(report.billed?.costByKind.cacheWrite).toBeCloseTo(10);
    expect(report.billed?.costUsd).toBeCloseTo(10);
  });

  it("reports the cache hit rate over the input side only", () => {
    const report = build([logged], {
      billed: [
        billed({
          inputTokens: 0,
          outputTokens: 500_000, // never cacheable, must not count
          cacheReadTokens: 750_000,
          cacheWrite5mTokens: 250_000,
        }),
      ],
    });
    expect(report.billed?.cacheHitRate).toBeCloseTo(0.75);
  });

  it("separates subagent spend from the total", () => {
    const report = build([logged], {
      billed: [billed(), billed({ requestId: "r2", isSidechain: true })],
    });
    expect(report.billed?.costUsd).toBeCloseTo(10);
    expect(report.billed?.sidechainCostUsd).toBeCloseTo(5);
  });

  it("ranks sessions by cost, named by their titles", () => {
    const cheap = session({
      sessionId: "s2",
      title: "A quick question",
      providerSessionId: "provider-2",
      turns: [turn()],
    });
    const report = build([logged, cheap], {
      billed: [
        billed({ requestId: "r1" }),
        billed({ requestId: "r2" }),
        billed({ requestId: "r3", sessionId: "provider-2" }),
      ],
    });
    expect(report.billed?.bySession.map((s) => s.label)).toEqual([
      "A session",
      "A quick question",
    ]);
    expect(report.billed?.bySession[0].costUsd).toBeCloseTo(10);
  });

  it("totals the bill per vendor, dearest first", () => {
    const other = session({
      sessionId: "s2",
      provider: "codex",
      providerSessionId: "provider-2",
      turns: [turn()],
    });
    const report = build([logged, other], {
      billed: [
        billed({ requestId: "r1" }),
        billed({ requestId: "r2", model: "claude-haiku-4-5-20251001" }),
        billed({ requestId: "r3", sessionId: "provider-2", model: "gpt-5" }),
      ],
    });
    const rows = report.billed?.byProvider ?? [];
    expect(rows.map((p) => p.provider)).toEqual(["claude", "codex"]);
    // $5 opus + $1 haiku, both billed to claude.
    expect(rows[0].costUsd).toBeCloseTo(6);
    expect(rows[0].requests).toBe(2);
    expect(rows[0].tokens.inputTokens).toBe(2_000_000);
    // Every request lands in exactly one row, so the rows add up.
    expect(rows.reduce((sum, p) => sum + p.costUsd, 0)).toBeCloseTo(
      report.billed?.costUsd ?? 0,
    );
  });

  it("groups by the full model ids the vendor reports", () => {
    const report = build([logged], {
      billed: [
        billed({ requestId: "r1" }),
        billed({ requestId: "r2", model: "claude-haiku-4-5-20251001" }),
      ],
    });
    expect(report.billed?.byModel.map((m) => m.model)).toEqual([
      "claude-opus-5",
      "claude-haiku-4-5-20251001",
    ]);
    expect(report.billed?.byModel[1].costUsd).toBeCloseTo(1); // haiku $1/M
  });
});

describe("delegation, measured in the context it leaves behind", () => {
  const rowFor = (turns: readonly TurnStat[]) =>
    build([session({ turns })]).tokens.byCommand[0];

  it("splits a command's runs by where they ran", () => {
    const row = rowFor([
      turn({ command: "/x", tokens: 30_000 }),
      turn({ command: "/x", tokens: 30_000 }),
      turn({ command: "/x", tokens: 2_000, agent: "a" }),
    ]);
    expect(row.turns).toBe(3);
    expect(row.inChat.turns).toBe(2);
    expect(row.inChat.contextAdded).toBe(60_000);
    expect(row.delegated.turns).toBe(1);
    expect(row.delegated.contextAdded).toBe(2_000);
  });

  it("says nothing for a command nobody chose to delegate", () => {
    expect(delegationReport(rowFor([turn({ command: "/x", tokens: 1 })]), false)).toEqual(
      {
        kind: "silent",
      },
    );
  });

  it("admits it has no runs at all rather than showing a blank", () => {
    expect(delegationReport(undefined, true)).toEqual({ kind: "noRuns" });
  });

  it("shows what the command costs the chat before it is ever delegated", () => {
    const report = delegationReport(
      rowFor([
        turn({ command: "/x", tokens: 30_000 }),
        turn({ command: "/x", tokens: 10_000 }),
      ]),
      true,
    );
    expect(report.kind).toBe("baseline");
    if (report.kind !== "baseline") throw new Error("wrong kind");
    expect(report.inChat).toEqual({ perRun: 20_000, turns: 2 });
  });

  it("says so when only the delegated side has been measured", () => {
    const report = delegationReport(
      rowFor([turn({ command: "/x", tokens: 2_000, agent: "a" })]),
      true,
    );
    expect(report.kind).toBe("delegatedOnly");
    if (report.kind !== "delegatedOnly") throw new Error("wrong kind");
    expect(report.delegated).toEqual({ perRun: 2_000, turns: 1 });
  });

  it("reports what delegating keeps out of the chat, per run", () => {
    const report = delegationReport(
      rowFor([
        turn({ command: "/x", tokens: 20_000 }),
        turn({ command: "/x", tokens: 20_000 }),
        turn({ command: "/x", tokens: 2_000, agent: "a" }),
      ]),
      true,
    );
    expect(report.kind).toBe("compared");
    if (report.kind !== "compared") throw new Error("wrong kind");
    // Per run, so running it in the chat twice as often cannot flip the
    // answer the way comparing totals would.
    expect(report.keptOut).toBe(18_000);
  });

  it("admits when delegating left MORE behind than running it here", () => {
    // Observed for real: a delegated run can add more than an inline one
    // if the child's tool calls reach the parent transcript anyway.
    const report = delegationReport(
      rowFor([
        turn({ command: "/x", tokens: 57_000 }),
        turn({ command: "/x", tokens: 86_000, agent: "a" }),
      ]),
      true,
    );
    if (report.kind !== "compared") throw new Error("wrong kind");
    expect(report.keptOut).toBeLessThan(0);
  });

  it("is not swayed by how deep in a conversation each side ran", () => {
    // Billed tokens would be: the deep run re-reads far more context.
    // Context ADDED is the same either way, and that is the point.
    const shallow = rowFor([turn({ command: "/x", tokens: 10_000 })]);
    const deep = build([
      session({
        turns: [...Array(40)]
          .map(() => turn({ command: "/y", tokens: 1_000 }))
          .concat(turn({ command: "/x", tokens: 10_000 })),
      }),
    ]).tokens.byCommand.find((r) => r.command === "/x");
    expect(deep?.inChat.contextAdded).toBe(shallow.inChat.contextAdded);
  });
});
