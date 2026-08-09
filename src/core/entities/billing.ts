/**
 * Entities layer — tokens a vendor actually BILLED, as opposed to the
 * context-window occupancy ACP reports (see insights.ts).
 *
 * The distinction is the whole point: every turn re-sends the whole
 * conversation, so what a session costs is dominated by cache reads and
 * cache writes, neither of which is visible in an occupancy delta. Pure
 * arithmetic here; what a token COSTS lives in modelPricing.ts.
 */

/** Tokens billed, split by how they were charged. */
export interface BilledTokens {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Cache writes at the 5-minute TTL (charged above the input rate). */
  readonly cacheWrite5mTokens: number;
  /** Cache writes at the 1-hour TTL (charged higher still). */
  readonly cacheWrite1hTokens: number;
  /** Cache hits — an order of magnitude cheaper than writing them. */
  readonly cacheReadTokens: number;
}

/** One billed API request.
 *  Mirrors `BilledRequest` in src-tauri/agent-core/src/billing.rs. */
export interface BilledRequest extends BilledTokens {
  readonly requestId: string;
  /** The PROVIDER's conversation id — joins to a transcript's
   *  `providerSessionId`, never to our local session id. */
  readonly sessionId: string;
  readonly timestampMs: number;
  readonly model: string;
  /** Subagent traffic: billed to the same account, but attributable to
   *  no top-level turn. */
  readonly isSidechain: boolean;
}

export const NO_BILLED_TOKENS: BilledTokens = {
  inputTokens: 0,
  outputTokens: 0,
  cacheWrite5mTokens: 0,
  cacheWrite1hTokens: 0,
  cacheReadTokens: 0,
};

export function addBilled(a: BilledTokens, b: BilledTokens): BilledTokens {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    cacheWrite5mTokens: a.cacheWrite5mTokens + b.cacheWrite5mTokens,
    cacheWrite1hTokens: a.cacheWrite1hTokens + b.cacheWrite1hTokens,
    cacheReadTokens: a.cacheReadTokens + b.cacheReadTokens,
  };
}

export function sumBilled(parts: readonly BilledTokens[]): BilledTokens {
  return parts.reduce(addBilled, NO_BILLED_TOKENS);
}

export function totalBilledTokens(tokens: BilledTokens): number {
  return (
    tokens.inputTokens +
    tokens.outputTokens +
    tokens.cacheWrite5mTokens +
    tokens.cacheWrite1hTokens +
    tokens.cacheReadTokens
  );
}

/**
 * Share of the input side served from cache, 0..1; null when nothing was
 * billed on the input side.
 *
 * The health metric to watch: a long conversation should sit high, since
 * every turn re-sends a prefix the vendor already has. A low number means
 * something keeps invalidating that prefix — an agent restart, a model
 * switch, a compaction — and is being paid for at write rates instead.
 * Output tokens are excluded: they are never cacheable, so counting them
 * would make a talkative session look unhealthy.
 */
export function cacheHitRate(tokens: BilledTokens): number | null {
  const inputSide =
    tokens.inputTokens +
    tokens.cacheWrite5mTokens +
    tokens.cacheWrite1hTokens +
    tokens.cacheReadTokens;
  return inputSide === 0 ? null : tokens.cacheReadTokens / inputSide;
}
