import type { ProviderId } from "./provider";

/**
 * Entities layer — rough $ pricing per model family, for the Insights
 * section only. The app never sees billed input/output/cache tokens
 * (ACP reports context-window deltas), so cost is estimated at a single
 * BLENDED rate per token and every display of it must carry an "≈".
 *
 * Blend: context growth is dominated by input-side accumulation (tool
 * results, files, history), so input is weighted 3:1 over output.
 * Vendor list prices (USD per 1M tokens) verified 2026-08.
 */
const INPUT_WEIGHT = 0.75;

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
];

/** Family assumed when the user runs the provider's default model. */
const DEFAULT_MODEL_MATCH: Readonly<Record<ProviderId, string>> = {
  claude: "sonnet",
  codex: "gpt-5.5",
  gemini: "gemini-3.1-pro",
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
  const target =
    model?.toLowerCase() ?? DEFAULT_MODEL_MATCH[provider as ProviderId] ?? undefined;
  if (target === undefined) return null;
  const entry = MODEL_PRICES.find(
    (p) => p.provider === provider && target.includes(p.match),
  );
  if (!entry) return null;
  return entry.inputPerMTok * INPUT_WEIGHT + entry.outputPerMTok * (1 - INPUT_WEIGHT);
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
