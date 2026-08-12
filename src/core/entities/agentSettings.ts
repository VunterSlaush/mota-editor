import type { ProviderId } from "./provider";

/**
 * Entities layer — per-tab agent behavior settings.
 */
export type AgentMode = "agent" | "plan" | "debug";
export type PermissionPolicy = "manual" | "auto" | "bypass";

export interface OptionDescriptor<T extends string> {
  readonly id: T;
  readonly label: string;
  readonly description: string;
}

export const MODES: readonly OptionDescriptor<AgentMode>[] = [
  {
    id: "agent",
    label: "Agent",
    description: "Work autonomously: read, edit, and run things in the project.",
  },
  {
    id: "plan",
    label: "Plan",
    description: "Analyze only — produce a step-by-step plan, change nothing.",
  },
  {
    id: "debug",
    label: "Debug",
    description:
      "Diagnose first: reproduce, find the root cause, then propose a minimal fix.",
  },
];

export const PERMISSIONS: readonly OptionDescriptor<PermissionPolicy>[] = [
  {
    id: "manual",
    label: "Manual approval",
    description:
      "Safe defaults — the agent's risky actions are denied or sandboxed by its CLI.",
  },
  {
    id: "auto",
    label: "Auto",
    description: "The agent works freely and asks only when an action looks risky.",
  },
  {
    id: "bypass",
    label: "Bypass permissions",
    description: "The agent acts without asking. Use only in projects you trust.",
  },
];

export const DEFAULT_MODE: AgentMode = "agent";
export const DEFAULT_PERMISSION: PermissionPolicy = "manual";

export type AutoCompactPolicy = "compact" | "newChat" | "ask" | "off";

/**
 * What to do when a session's context window fills up.
 *
 * Every description says what actually happens, because the cheapest
 * option is also the one that loses something: a new chat costs no tokens
 * precisely because the agent forgets. Measured on real logs, compaction
 * saves about as much as it costs, while conversation LENGTH is what
 * drives the bill — a turn past the hundredth costs ~2.7x an early one,
 * because every turn re-sends the whole conversation.
 */
export const AUTO_COMPACT_POLICIES: readonly OptionDescriptor<AutoCompactPolicy>[] = [
  {
    id: "newChat",
    label: "Start a new chat",
    description:
      "The agent forgets and the screen clears; the conversation stays in History. Cheapest — a fresh chat re-sends nothing.",
  },
  {
    id: "compact",
    label: "Compact automatically",
    description:
      "The agent summarizes the conversation and keeps working. Costs a full pass over the context, and saves about as much.",
  },
  {
    id: "ask",
    label: "Ask me",
    description:
      "Offers both, with what each one costs, and does nothing until you pick.",
  },
  {
    id: "off",
    label: "Do nothing",
    description: "Never intervene. The agent handles a full context its own way.",
  },
];

/** Below this compaction would thrash. */
export const MIN_AUTO_COMPACT_THRESHOLD = 0.5;
/** Above this it fires too late to leave room for the compact turn. */
export const MAX_AUTO_COMPACT_THRESHOLD = 0.95;
/** 0.90, not 0.85: compacting costs a full pass over the context and a
 *  cache re-write on the turn after, so firing early spends money to
 *  save money. Matches the default Zed ships. */
export const DEFAULT_AUTO_COMPACT_THRESHOLD = 0.9;

/**
 * A threshold inside the usable range. A corrupt persisted value would
 * otherwise be catastrophic in both directions: 0 compacts on every
 * turn, anything above 1 never compacts at all.
 */
export function clampAutoCompactThreshold(fraction: number): number {
  if (!Number.isFinite(fraction)) return DEFAULT_AUTO_COMPACT_THRESHOLD;
  return Math.min(
    MAX_AUTO_COMPACT_THRESHOLD,
    Math.max(MIN_AUTO_COMPACT_THRESHOLD, fraction),
  );
}

export type CostPresetId = "economy" | "balanced" | "max";

/** The model and effort a preset sets, per provider. */
export interface CostPreset extends OptionDescriptor<CostPresetId> {
  readonly model: Readonly<Record<ProviderId, string>>;
  readonly effort: Readonly<Record<ProviderId, string>>;
}

/**
 * Cost presets — model and effort chosen TOGETHER.
 *
 * Separately, the two are easy to get wrong in the expensive direction:
 * the top model at maximum effort is a sensible pair for a hard bug and
 * an absurd one for a rename, but nothing about two independent pickers
 * says so. Picking a posture instead of two values is the difference.
 *
 * These seed NEW tabs only (the AppSettings contract), so choosing one
 * never respawns a running agent.
 */
export const COST_PRESETS: readonly CostPreset[] = [
  {
    id: "economy",
    label: "Economy",
    description: "A small model at low effort — for edits, renames, and commit messages.",
    model: { claude: "haiku", codex: "gpt-5.4-mini", gemini: "gemini-2.5-flash" },
    effort: { claude: "low", codex: "low", gemini: "" },
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "The everyday pairing — capable enough for real work, priced sanely.",
    model: { claude: "sonnet", codex: "gpt-5.3-codex", gemini: "gemini-3-flash-preview" },
    effort: { claude: "medium", codex: "medium", gemini: "" },
  },
  {
    id: "max",
    label: "Maximum",
    description:
      "The strongest model at high effort. Costs the most — save it for hard problems.",
    model: { claude: "opus", codex: "gpt-5.5", gemini: "gemini-3.1-pro-preview" },
    effort: { claude: "high", codex: "high", gemini: "" },
  },
];

/**
 * The preset a provider's current model+effort corresponds to, or null
 * when the pair is the user's own. Derived rather than stored: the
 * model and effort remain individually editable, and a stored preset id
 * would start lying the moment either changed.
 */
export function matchingCostPreset(
  provider: ProviderId,
  model: string | undefined,
  effort: string | undefined,
): CostPresetId | null {
  const found = COST_PRESETS.find(
    (preset) =>
      preset.model[provider] === (model ?? "") &&
      preset.effort[provider] === (effort ?? ""),
  );
  return found?.id ?? null;
}

/**
 * Map an agent's native session-mode id (ACP `current_mode_update`) to
 * the app's mode vocabulary. The agent's ids are its own (Claude:
 * auto/default/acceptEdits/plan/dontAsk/bypassPermissions; Codex:
 * read-only/agent); anything unrecognized returns null and the picker
 * stays as it is — better than guessing a mode the user never chose.
 */
export function modeFromAgentModeId(modeId: string): AgentMode | null {
  switch (modeId) {
    case "plan":
    case "read-only":
      return "plan";
    case "default":
    case "auto":
    case "acceptEdits":
    case "dontAsk":
    case "bypassPermissions":
    case "agent":
      return "agent";
    default:
      return null;
  }
}
