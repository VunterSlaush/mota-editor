import type { BilledTokens } from "./billing";
import type { ProviderId } from "./provider";

/**
 * Entities layer — $ pricing per model family, for the Insights section.
 *
 * Two paths, deliberately kept apart:
 *
 * - EXACT (`billedCostUsd`): the vendor's own log told us what was
 *   billed, down to the cache split. Displays must NOT mark it "≈".
 * - ESTIMATED (`estimateCostUsd`): all we have is an ACP context-window
 *   delta, so cost is a single BLENDED rate over an occupancy figure and
 *   every display of it must carry an "≈".
 *
 * Blend: context growth is dominated by input-side accumulation (tool
 * results, files, history), so input is weighted 3:1 over output.
 * Vendor list prices (USD per 1M tokens) verified 2026-08.
 */
const INPUT_WEIGHT = 0.75;

/**
 * Cache rates, as multiples of a model's input rate. Anthropic prices
 * cache traffic relative to input rather than listing it per model, so
 * one set of multipliers covers the whole table.
 */
const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
const CACHE_READ = 0.1;

interface PriceEntry {
  readonly provider: ProviderId;
  /** Substring matched against the lowercased model id; first match
   *  wins, so more specific entries must precede their prefixes. */
  readonly match: string;
  readonly inputPerMTok: number;
  readonly outputPerMTok: number;
}

export const MODEL_PRICES: readonly PriceEntry[] = [
  // Anthropic
  { provider: "claude", match: "fable", inputPerMTok: 10, outputPerMTok: 50 },
  { provider: "claude", match: "opusplan", inputPerMTok: 5, outputPerMTok: 25 },
  { provider: "claude", match: "opus", inputPerMTok: 5, outputPerMTok: 25 },
  { provider: "claude", match: "sonnet", inputPerMTok: 3, outputPerMTok: 15 },
  { provider: "claude", match: "haiku", inputPerMTok: 1, outputPerMTok: 5 },
  // OpenAI
  { provider: "codex", match: "gpt-5.5", inputPerMTok: 5, outputPerMTok: 30 },
  { provider: "codex", match: "gpt-5.4", inputPerMTok: 2.5, outputPerMTok: 15 },
  { provider: "codex", match: "gpt-5.3-codex", inputPerMTok: 1.75, outputPerMTok: 14 },
  // Google
  { provider: "gemini", match: "gemini-3.1-pro", inputPerMTok: 2, outputPerMTok: 12 },
  { provider: "gemini", match: "gemini-2.5-pro", inputPerMTok: 1.25, outputPerMTok: 10 },
  {
    provider: "gemini",
    match: "gemini-2.5-flash",
    inputPerMTok: 0.3,
    outputPerMTok: 2.5,
  },
  // OpenCode Zen, priced at zero. Scoped to the gateway's own naming
  // rather than the provider as a whole: a paid model the user routed
  // through opencode (OpenRouter, an Anthropic key, anything else) has a
  // real price this table does not know, and must fall through to "n/a"
  // instead of being reported as free.
  { provider: "opencode", match: "-free", inputPerMTok: 0, outputPerMTok: 0 },
  { provider: "opencode", match: "big-pickle", inputPerMTok: 0, outputPerMTok: 0 },
  // DeepSeek over the same gateway, which bills it rather than serving it
  // free (models.dev, verified 2026-08-31). These sit BELOW the "-free"
  // row on purpose: `deepseek-v4-flash-free` contains "-free", so the
  // zero-price row must win for it before either of these is reached.
  {
    provider: "opencode",
    match: "deepseek-v4-pro",
    inputPerMTok: 1.74,
    outputPerMTok: 3.84,
  },
  {
    provider: "opencode",
    match: "deepseek-v4-flash",
    inputPerMTok: 0.14,
    outputPerMTok: 0.28,
  },
  // Cline is deliberately absent: its account serves both free and paid
  // models under ids we cannot read without the user's credentials, so
  // every Cline turn shows "n/a" rather than a number that might be a lie.
];

/** Family assumed when the user runs the provider's default model. */
const DEFAULT_MODEL_MATCH: Readonly<Record<ProviderId, string>> = {
  claude: "sonnet",
  codex: "gpt-5.5",
  gemini: "gemini-3.1-pro",
  // opencode's own default when no model is set (verified 2026-08).
  opencode: "big-pickle",
  // Empty on purpose: nothing matches, so an unset Cline model prices as
  // unknown rather than guessing at an account we cannot see.
  cline: "",
  // Also empty, for a different reason: Copilot's default is `auto`,
  // which routes each turn to a model it chooses at send time. There is
  // no default family to assume, so a turn prices as unknown unless the
  // user pinned a model.
  copilot: "",
};

/**
 * Blended USD per 1M tokens for a model, or null when the model (or
 * provider) is unknown — the UI shows "n/a" rather than a fake number.
 * `undefined` model means the provider default.
 */
export function blendedRatePerMTok(
  provider: string,
  model: string | undefined,
): number | null {
  const entry = priceFor(provider, model);
  if (!entry) return null;
  return entry.inputPerMTok * INPUT_WEIGHT + entry.outputPerMTok * (1 - INPUT_WEIGHT);
}

/**
 * Exact cost in USD for tokens the vendor reported as billed; null when
 * the model has no known price.
 *
 * Unlike `estimateCostUsd` this needs no blending: each bucket is
 * charged at its own rate, which is why a cache-heavy session can cost a
 * fraction of what its raw token count suggests — and why a session that
 * keeps re-writing its cache costs far more.
 */
export function billedCostUsd(
  tokens: BilledTokens,
  provider: string,
  model: string | undefined,
): number | null {
  const entry = priceFor(provider, model);
  if (!entry) return null;
  const input = entry.inputPerMTok;
  const perMTok =
    tokens.inputTokens * input +
    tokens.outputTokens * entry.outputPerMTok +
    tokens.cacheWrite5mTokens * input * CACHE_WRITE_5M +
    tokens.cacheWrite1hTokens * input * CACHE_WRITE_1H +
    tokens.cacheReadTokens * input * CACHE_READ;
  return perMTok / 1_000_000;
}

/** The price row for a model; `undefined` model means the provider default. */
function priceFor(provider: string, model: string | undefined): PriceEntry | null {
  const target =
    model?.toLowerCase() ?? DEFAULT_MODEL_MATCH[provider as ProviderId] ?? undefined;
  if (target === undefined) return null;
  return (
    MODEL_PRICES.find((p) => p.provider === provider && target.includes(p.match)) ?? null
  );
}

/** Money for display: "$12.40", and "<$0.01" rather than a bare "$0.00"
 *  for spend too small to round to a cent but real enough to have
 *  happened. */
export function formatUsd(usd: number): string {
  if (usd > 0 && usd < 0.01) return "<$0.01";
  return `$${usd.toFixed(2)}`;
}

/** Rough cost in USD for a token count; null when the rate is unknown. */
export function estimateCostUsd(
  tokens: number,
  provider: string,
  model: string | undefined,
): number | null {
  const rate = blendedRatePerMTok(provider, model);
  if (rate === null) return null;
  return (tokens / 1_000_000) * rate;
}
