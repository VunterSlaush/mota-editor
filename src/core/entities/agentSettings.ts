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
    description: "Diagnose first: reproduce, find the root cause, then propose a minimal fix.",
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
