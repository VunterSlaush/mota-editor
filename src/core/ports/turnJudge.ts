import type { TurnJudgeInput, TurnVerdict } from "../entities/jev";

/**
 * Ports layer — a second opinion on a finished turn (ADR-0025).
 *
 * Advisory only: the verdict becomes a badge, never a decision. Never
 * throws — no key, no network, a malformed reply all answer null, and
 * the turn simply goes unjudged.
 */
export interface TurnJudge {
  judge(input: TurnJudgeInput): Promise<TurnVerdict | null>;
}
