/**
 * Entities layer — AI agent providers the workbench can drive.
 * Pure domain vocabulary; knows nothing about CLIs, HTTP, or Tauri.
 */
export type ProviderId = "claude" | "codex" | "gemini" | "opencode" | "cline" | "copilot";

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
  // Copilot's free individual tier is why it sits with these two. It
  // advertises `loadSession` at the handshake (verified 2026-08 against
  // CLI 1.0.81). Its window moves with whichever model `auto` routes to,
  // so the descriptor states the smallest prompt budget seen on a free
  // account and real `usage_update`s correct it on the first turn.
  {
    id: "copilot",
    displayName: "Copilot",
    vendor: "GitHub",
    supportsResume: true,
    contextWindow: 128_000,
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
  // OpenCode's own gateway. The free lineup rotates faster than any
  // other provider's: re-check it with `opencode models`, which lists
  // only what is being served right now. A model that has rotated out
  // fails the turn with an opaque "Unexpected server error", so a stale
  // entry here is a landmine rather than a cosmetic wart — three were
  // dropped on 2026-08-31 after failing exactly that way.
  //
  // The DeepSeek rows are the durable ones: the gateway bills them
  // rather than rotating them, so they stay selectable and only need
  // `opencode auth login`. Models from any other gateway the user
  // configured in opencode are reachable by their `vendor/model` id,
  // which the picker keeps once it has been chosen.
  opencode: [
    "opencode/big-pickle",
    "opencode/deepseek-v4-flash",
    "opencode/deepseek-v4-pro",
    "opencode/ling-3.0-flash-fin-free",
    "opencode/mimo-v2.5-free",
    "opencode/muse-spark-1.2-contributor-free",
    "opencode/nemotron-3-ultra-free",
    "opencode/nemotron-3.5-lightning-free",
  ],
  // Deliberately empty: `cline auth` both signs the account in and
  // chooses its model, and the account's catalogue is fetched at runtime
  // from credentials we do not hold. Offering guessed ids would put
  // entries in the picker that fail only once the user sends a prompt.
  // An empty list is not a dead end — the model control becomes a text
  // field, so any id the account accepts (`~z-ai/glm-latest`) can be
  // typed and is then remembered per tab like any other.
  cline: [],
  // Just `auto`, and only after checking. The obvious list to write here
  // is the one Copilot's own router reports it is choosing between
  // (`session.auto_mode_resolved.availableModels` named gpt-5-mini and
  // claude-haiku-4.5 on a free account) — and every one of those is
  // refused by `--model` with "Model \"gpt-5-mini\" from --model flag is
  // not available", because what the router may pick and what the
  // account may pin are different entitlements. `auto` is the only id
  // verified to be accepted on a free plan, and it is also the CLI's own
  // default. A paid plan pins real ids, which the picker takes as typed
  // text and remembers per tab.
  copilot: ["auto"],
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
  // DeepSeek over opencode carries 1M, five times the conservative
  // gateway floor the descriptor states. The free variant is the one
  // exception at 200k, and has to precede the prefix it contains or it
  // would inherit 1M (models.dev, verified 2026-08-31).
  { provider: "opencode", match: "deepseek-v4-flash-free", tokens: 200_000 },
  { provider: "opencode", match: "deepseek-v4", tokens: 1_000_000 },
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
  // Copilot's `--effort`, whose choices its own `--help` enumerates.
  // Note this is the CLI's vocabulary, not the model's: the capture
  // showed gpt-5-mini supporting only low/medium/high underneath, so an
  // outer level is a request the router narrows, not a guarantee.
  copilot: ["none", "minimal", "low", "medium", "high", "xhigh", "max"],
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
  copilot: "/compact",
};
