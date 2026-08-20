/**
 * Entities layer — AI agent providers the workbench can drive.
 * Pure domain vocabulary; knows nothing about CLIs, HTTP, or Tauri.
 */
export type ProviderId = "claude" | "codex" | "gemini" | "opencode" | "cline";

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly displayName: string;
  readonly vendor: string;
  /** Whether the provider can continue a previous conversation turn. */
  readonly supportsResume: boolean;
  /** Context window (tokens) of the provider's DEFAULT model — the
   *  fallback when `contextWindowFor` has no per-model entry (verified
   *  against vendor docs 2026-08). Real `usage_update`s always win. */
  readonly contextWindow: number;
}

export const PROVIDERS: readonly ProviderDescriptor[] = [
  {
    id: "claude",
    displayName: "Claude",
    vendor: "Anthropic",
    supportsResume: true,
    contextWindow: 1_000_000,
  },
  {
    id: "codex",
    displayName: "ChatGPT (Codex)",
    vendor: "OpenAI",
    supportsResume: true,
    contextWindow: 400_000,
  },
  {
    id: "gemini",
    displayName: "Gemini",
    vendor: "Google",
    supportsResume: false,
    contextWindow: 1_000_000,
  },
  // Free-tier agents, so a workbench stays usable once a paid plan is
  // spent. Both advertise `loadSession` at the ACP handshake (verified
  // 2026-08). Their context window depends on which gateway the user
  // authenticated, so the descriptor states a conservative floor and
  // real `usage_update`s correct it on the first turn.
  {
    id: "opencode",
    displayName: "OpenCode",
    vendor: "opencode",
    supportsResume: true,
    contextWindow: 200_000,
  },
  {
    id: "cline",
    displayName: "Cline",
    vendor: "Cline",
    supportsResume: true,
    contextWindow: 200_000,
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
  // OpenCode's own gateway, listed by `opencode models` 2026-08-20 — the
  // models it serves at no charge and without a sign-in. The lineup
  // rotates faster than the others, so treat a stale entry here as
  // expected rather than surprising. Models from any other gateway the
  // user configured in opencode are reachable by their `vendor/model`
  // id, which the picker keeps once it has been chosen.
  opencode: [
    "opencode/big-pickle",
    "opencode/nemotron-3-ultra-free",
    "opencode/nemotron-3.5-lightning-free",
    "opencode/deepseek-v4-flash-free",
    "opencode/mimo-v2.5-free",
    "opencode/hy3-free",
    "opencode/x-preview-f-free",
  ],
  // Deliberately empty: `cline auth` both signs the account in and
  // chooses its model, and the account's catalogue is not readable
  // without those credentials. Offering guessed ids would put entries in
  // the picker that fail only once the user sends a prompt.
  cline: [],
};

interface ContextWindowEntry {
  readonly provider: ProviderId;
  /** Substring matched against the lowercased model id; first match
   *  wins, so more specific entries must precede their prefixes. */
  readonly match: string;
  readonly tokens: number;
}

/**
 * Models whose window differs from their provider's default (verified
 * against vendor docs 2026-08): every current Claude line is 1M except
 * Haiku; GPT-5.x is 400K across the family; every current Gemini is 1M,
 * so it needs no rows.
 */
const MODEL_CONTEXT_WINDOWS: readonly ContextWindowEntry[] = [
  { provider: "claude", match: "haiku", tokens: 200_000 },
  { provider: "codex", match: "gpt-5", tokens: 400_000 },
];

/**
 * The context window (tokens) for a model on a provider — the
 * denominator for ESTIMATED usage when the agent reports none.
 * `undefined` or empty model means the provider default. Real
 * `usage_update`s always win; this only feeds the estimate path.
 */
export function contextWindowFor(
  provider: ProviderId,
  model: string | undefined,
): number {
  const target = model?.trim().toLowerCase();
  if (target) {
    const entry = MODEL_CONTEXT_WINDOWS.find(
      (e) => e.provider === provider && target.includes(e.match),
    );
    if (entry) return entry.tokens;
  }
  return providerById(provider).contextWindow;
}

/** What the Claude ACP adapter reports as `usage_update.size` for a
 *  fresh session before any turn has run (`DEFAULT_CONTEXT_WINDOW` in
 *  @agentclientprotocol/claude-agent-acp). */
const CLAUDE_ADAPTER_SEED_WINDOW = 200_000;

/**
 * Whether an agent-reported context size is a PLACEHOLDER rather than
 * the session's confirmed window.
 *
 * The Claude adapter seeds a fresh session's `size` with 200k and only
 * learns the authoritative window when the first turn completes. A
 * report matching that signature — exactly the seed, on a model whose
 * window is known to be larger — is trustworthy in `used` but not in
 * `size`, and displays should say so instead of announcing a full-looking
 * gauge that quintuples moments later.
 */
export function isProvisionalContextSize(
  provider: ProviderId,
  model: string | undefined,
  size: number,
): boolean {
  return (
    provider === "claude" &&
    size === CLAUDE_ADAPTER_SEED_WINDOW &&
    contextWindowFor(provider, model) > size
  );
}

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
  // opencode's effort control (`--variant`) exists only on its one-shot
  // run command; the ACP server it drives here has no config key for it.
  opencode: [],
  // Cline's `--thinking`, which it takes alongside `--acp`.
  cline: ["none", "low", "medium", "high", "xhigh"],
};

/**
 * The slash command that compacts/summarizes the conversation to free
 * context, per provider (best-effort — sent as a normal prompt turn).
 */
export const COMPACT_COMMAND: Readonly<Record<ProviderId, string>> = {
  claude: "/compact",
  codex: "/compact",
  gemini: "/compress",
  opencode: "/compact",
  cline: "/compact",
};
