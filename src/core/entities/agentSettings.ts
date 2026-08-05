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
