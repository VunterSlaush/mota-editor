/**
 * Entities layer — AI agent providers the workbench can drive.
 * Pure domain vocabulary; knows nothing about CLIs, HTTP, or Tauri.
 */
export type ProviderId = "claude" | "codex" | "gemini";

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly vendor: string;
  /** Whether the provider can continue a previous conversation turn. */
  readonly supportsResume: boolean;
  /** Typical context window (tokens) of the provider's default model —
   *  the denominator for ESTIMATED usage when the agent reports none.
   *  Deliberately conservative; real `usage_update`s always win. */
  readonly contextWindow: number;
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "claude",
    displayName: "Claude",
    vendor: "Anthropic",
    supportsResume: true,
    contextWindow: 200_000,
  },
  {
    id: "codex",
    displayName: "ChatGPT (Codex)",
    vendor: "OpenAI",
    supportsResume: true,
    contextWindow: 200_000,
  },
  {
    id: "gemini",
    displayName: "Gemini",
    vendor: "Google",
    supportsResume: false,
    contextWindow: 1_000_000,
  },
];

export function providerById(id: ProviderId): ProviderDescriptor {
  const found = PROVIDERS.find((p) => p.id === id);
  if (!found) throw new Error(`Unknown provider: ${id}`);
  return found;
}

export const DEFAULT_PROVIDER: ProviderId = "claude";

/**
 * Model suggestions per provider — the model picker's whole dropdown
 * (verified against vendor docs 2026-08). This is now the only way to
 * choose a model, so a stale list blocks anyone needing a newer id:
 * keep it current. Empty string means provider default. A model already
 * stored from an earlier build is kept as its own option, so a value
 * missing here is never silently dropped. Claude aliases resolve to
 * the newest of each line (fable → claude-fable-5, opus → claude-opus-5,
 * sonnet → claude-sonnet-5, haiku → claude-haiku-4-5).
 */
export const MODEL_SUGGESTIONS: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: ["sonnet", "opus", "fable", "haiku", "opusplan"],
  codex: ["gpt-5.5", "gpt-5.3-codex", "gpt-5.4", "gpt-5.4-mini"],
  gemini: [
    "gemini-3.1-pro-preview",
    "gemini-3-pro-preview",
    "gemini-3-flash-preview",
    "gemini-2.5-pro",
    "gemini-2.5-flash",
  ],
};

/**
 * Reasoning-effort levels per provider, in each vendor's own vocabulary
 * (Claude: CLAUDE_CODE_EFFORT_LEVEL; Codex: model_reasoning_effort).
 * Empty array = the provider exposes no effort control (Gemini CLI) and
 * the picker is hidden. Empty string means provider default.
 */
export const EFFORT_OPTIONS: Readonly<Record<ProviderId, readonly string[]>> = {
  claude: ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
  gemini: [],
};

/**
 * The slash command that compacts/summarizes the conversation to free
 * context, per provider (best-effort — sent as a normal prompt turn).
 */
export const COMPACT_COMMAND: Readonly<Record<ProviderId, string>> = {
  claude: "/compact",
  codex: "/compact",
  gemini: "/compress",
};
