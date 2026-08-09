import type { ProviderId } from "./provider";

/**
 * Entities layer — per-tab agent behavior settings.
 */
export type AgentMode = "agent" | "plan" | "debug";
export type PermissionPolicy = "manual" | "bypass";

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
    id: "bypass",
    label: "Bypass permissions",
    description: "The agent acts without asking. Use only in projects you trust.",
  },
];

export const DEFAULT_MODE: AgentMode = "agent";
export const DEFAULT_PERMISSION: PermissionPolicy = "manual";

export type AutoCompactPolicy = "compact" | "ask" | "off";

export const AUTO_COMPACT_POLICIES: readonly OptionDescriptor<AutoCompactPolicy>[] = [
  {
    id: "compact",
    label: "Compact automatically",
    description: "Mota asks the agent to summarize. Costs a full pass over the context.",
  },
  {
    id: "ask",
    label: "Ask me",
    description: "Offers compaction or a new chat, which costs nothing.",
  },
  {
    id: "off",
    label: "Do nothing",
    description: "Never compact. The agent handles a full context its own way.",
  },
];

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
