import type { AgentMode, PermissionPolicy } from "./agentSettings";
import type { ProviderId } from "./provider";

/**
 * Entities layer — a project is a folder the user works on in one tab.
 */
export interface Project {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  /** Provider currently selected for this project's chat. */
  readonly provider: ProviderId;
  /** How the agent behaves in this tab (agent / plan / debug). */
  readonly mode: AgentMode;
  /** How much the agent may do without asking. */
  readonly permission: PermissionPolicy;
  /** Model override for this tab's agent; empty/undefined = default. */
  readonly model?: string;
  /** Reasoning-effort override; empty/undefined = provider default. */
  readonly effort?: string;
  /** Verbose chat: show tool activity, thoughts, and status rows. */
  readonly verbose: boolean;
  /**
   * Provider-side conversation ids, per provider, so a chat can be
   * resumed across turns (and across app restarts where supported).
   */
  readonly providerSessions: Readonly<Partial<Record<ProviderId, string>>>;
  /**
   * When this folder is a linked git worktree, the path of the main
   * checkout it belongs to. Absent for ordinary folders.
   */
  readonly worktreeOf?: string;
}

export function projectNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

/**
 * What a brand-new tab starts with. Named here rather than taken from
 * `AppSettings` so entities stay ignorant of app state: the use case
 * resolves the app's per-provider model/effort down to this flat shape.
 */
export interface ProjectDefaults {
  readonly provider: ProviderId;
  readonly mode: AgentMode;
  readonly permission: PermissionPolicy;
  readonly model?: string;
  readonly effort?: string;
}

export function newProject(
  id: string,
  path: string,
  defaults: ProjectDefaults,
  worktreeOf?: string,
): Project {
  return {
    id,
    path,
    name: projectNameFromPath(path),
    provider: defaults.provider,
    mode: defaults.mode,
    permission: defaults.permission,
    model: defaults.model,
    effort: defaults.effort,
    verbose: true,
    providerSessions: {},
    worktreeOf,
  };
}
