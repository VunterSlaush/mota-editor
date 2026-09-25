import type { ChatMessage } from "./message";

/**
 * Entities layer — Jev, TypeSafe AI's classifier, as a second opinion on
 * the agent (ADR-0025). It gates tool calls (in the backend) and judges
 * finished turns (here). Never an authority: every failure means "carry
 * on as if Jev were off".
 */

export interface JevSettings {
  /** The master switch; nothing below it runs while this is off. */
  readonly enabled: boolean;
  /** Tool-call risk gate, and the `jev-auto` permission it makes possible. */
  readonly gate: boolean;
  /** Post-turn judge: a badge on each finished prompt. */
  readonly judge: boolean;
}

export const defaultJevSettings: JevSettings = {
  enabled: false,
  gate: true,
  judge: true,
};

export function jevGateActive(jev: JevSettings): boolean {
  return jev.enabled && jev.gate;
}

export function jevJudgeActive(jev: JevSettings): boolean {
  return jev.enabled && jev.judge;
}

/**
 * Why Jev put a tool call in front of the user. `reason` is the gate
 * question that scored highest (destructive | irreversible |
 * out_of_scope | opaque), or `unsure` when nothing stood out but nothing
 * was clearly safe either.
 */
export interface JevRiskVerdict {
  readonly risk: number;
  readonly reason: string;
}

/** Jev's read of one finished turn, each a probability from 0 to 1. */
export interface TurnVerdict {
  /** The agent did what was asked. */
  readonly completed: number;
  /** The agent claims success without showing it checked. */
  readonly unverifiedClaim: number;
  /** The agent left steps the user must still take. */
  readonly needsFollowUp: number;
}

/** A probability on the wrong side of this is worth the user's look. */
export const INCOMPLETE_THRESHOLD = 0.5;

export function verdictNeedsAttention(verdict: TurnVerdict): boolean {
  return worstConcern(verdict) !== null;
}

const RISK_PHRASES: Readonly<Record<string, string>> = {
  destructive: "likely destructive",
  irreversible: "likely irreversible",
  out_of_scope: "likely outside the project or task",
  opaque: "hard to judge from its text",
};

/** The approval card's line, e.g. "Jev: 91% likely destructive". */
export function describeRiskVerdict(verdict: JevRiskVerdict): string {
  const percent = asPercent(verdict.risk);
  const phrase = RISK_PHRASES[verdict.reason];
  if (phrase) return `Jev: ${percent}% ${phrase}`;
  return `Jev: not clearly safe (${percent}% risk)`;
}

export interface TurnVerdictSummary {
  readonly tone: "ok" | "warn";
  readonly label: string;
  /** All three readings, for a tooltip. */
  readonly detail: string;
}

export function describeTurnVerdict(verdict: TurnVerdict): TurnVerdictSummary {
  const detail = [
    `Completed: ${asPercent(verdict.completed)}%`,
    `Unverified claim: ${asPercent(verdict.unverifiedClaim)}%`,
    `Follow-ups left: ${asPercent(verdict.needsFollowUp)}%`,
  ].join(" · ");
  const concern = worstConcern(verdict);
  if (!concern) return { tone: "ok", label: "Jev: looks done", detail };
  return { tone: "warn", label: CONCERN_LABELS[concern], detail };
}

type Concern = "incomplete" | "unverified" | "followUp";

const CONCERN_LABELS: Readonly<Record<Concern, string>> = {
  incomplete: "Jev: may be incomplete",
  unverified: "Jev: success not verified",
  followUp: "Jev: follow-ups left for you",
};

/** The concern to lead with — not finishing outranks not checking. */
function worstConcern(verdict: TurnVerdict): Concern | null {
  if (verdict.completed < INCOMPLETE_THRESHOLD) return "incomplete";
  if (verdict.unverifiedClaim >= INCOMPLETE_THRESHOLD) return "unverified";
  if (verdict.needsFollowUp >= INCOMPLETE_THRESHOLD) return "followUp";
  return null;
}

function asPercent(probability: number): number {
  return Math.round(Math.min(1, Math.max(0, probability)) * 100);
}

/** What the turn judge shows Jev about one finished turn. */
export interface TurnJudgeInput {
  readonly prompt: string;
  /** The assistant's words this turn, the tail kept when long. */
  readonly answer: string;
  /** Titles of the first tool calls, in order. */
  readonly toolCalls: readonly string[];
  /** Every tool call this turn, including those past the title cap. */
  readonly toolCallCount: number;
  readonly stopReason?: string;
}

/** The end of an answer is where the agent says what it did. */
export const MAX_JUDGE_ANSWER_CHARS = 4000;
export const MAX_JUDGE_TOOL_TITLES = 20;

/**
 * The judge's view of the turn started by `promptMessageId`: everything
 * after that prompt up to the next one. Null once the prompt is gone
 * (cleared, replaced by a loaded transcript).
 */
export function turnJudgeInput(
  messages: readonly ChatMessage[],
  promptMessageId: string,
  stopReason: string | undefined,
): TurnJudgeInput | null {
  const at = messages.findIndex((m) => m.id === promptMessageId);
  if (at === -1) return null;
  const turn = rowsUntilNextPrompt(messages.slice(at + 1));
  const answer = turn
    .filter((m) => m.role === "assistant")
    .map((m) => m.text)
    .join("\n\n");
  const toolTitles = turn.filter((m) => m.role === "tool").map((m) => m.text);
  return {
    prompt: messages[at].text,
    answer:
      answer.length > MAX_JUDGE_ANSWER_CHARS
        ? answer.slice(-MAX_JUDGE_ANSWER_CHARS)
        : answer,
    toolCalls: toolTitles.slice(0, MAX_JUDGE_TOOL_TITLES),
    toolCallCount: toolTitles.length,
    ...(stopReason ? { stopReason } : {}),
  };
}

function rowsUntilNextPrompt(rows: readonly ChatMessage[]): readonly ChatMessage[] {
  const next = rows.findIndex((m) => m.role === "user");
  return next === -1 ? rows : rows.slice(0, next);
}

/** Jev's question vocabulary, as sent. */
export interface JevQuestion {
  readonly type: "noul" | "choice" | "score";
  readonly instructions: string;
  readonly criteria?: unknown;
}

/** Judge question keys, mapped to the verdict fields they fill. */
const JUDGE_KEYS = {
  completed: "completed",
  unverified_claim: "unverifiedClaim",
  needs_follow_up: "needsFollowUp",
} as const satisfies Record<string, keyof TurnVerdict>;

/** The three yes/no questions asked of every finished turn. */
export function judgeQuestions(): Readonly<Record<keyof typeof JUDGE_KEYS, JevQuestion>> {
  return {
    completed: {
      type: "noul",
      instructions:
        "The state is one turn of a coding agent: `prompt` is what the user asked, `answer` is what the agent replied, `toolCalls` lists the first tools it ran (`toolCallCount` is the total), and `stopReason` says how the turn ended. Did the agent complete the request as asked? Answer yes only when the answer shows the requested work was done, not merely planned, attempted or partly done.",
    },
    unverified_claim: {
      type: "noul",
      instructions:
        "Look at `answer` and `toolCalls`. Does the agent claim success (fixed, done, passing, working) without evidence it verified that — no test, build, lint or run among `toolCalls`, and no output quoted in `answer` that shows it? Answer no when the answer makes no success claim, or when it shows the check it ran.",
    },
    needs_follow_up: {
      type: "noul",
      instructions:
        "Read `answer`. Does the agent leave steps the user must take before the request in `prompt` is actually finished — commands to run, values to fill in, files to create, decisions to make, or work it explicitly deferred? Answer no for optional suggestions the user did not need to act on.",
    },
  };
}

/** One answer from Jev, as `jev_classify` returns it. */
export type JevAnswer =
  | { readonly type: "noul"; readonly noul: number }
  | {
      readonly type: "choice";
      readonly choice: string;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    }
  | {
      readonly type: "score";
      readonly score: number;
      readonly probabilities: Readonly<Record<string, number>>;
      readonly confidence: number;
    };

export interface JevAnswers {
  readonly model: string;
  readonly answers: Readonly<Record<string, JevAnswer>>;
  readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
}

/** The judge's answers as a verdict, or null when any is missing. */
export function turnVerdictFromAnswers(answers: JevAnswers): TurnVerdict | null {
  const verdict: Partial<Record<keyof TurnVerdict, number>> = {};
  for (const [key, field] of Object.entries(JUDGE_KEYS)) {
    const answer = answers.answers[key];
    if (answer?.type !== "noul") return null;
    verdict[field] = answer.noul;
  }
  return verdict as TurnVerdict;
}
