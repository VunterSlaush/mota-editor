import type { AgentMode, PermissionPolicy } from "./agentSettings";
import type { ProjectMcpOverrides } from "./mcpServer";
import type { ProviderId } from "./provider";
import type { BoundaryPreset, SubtaskScope } from "./subtask";
import type { TabColorId } from "./tabColor";
import type { ProvisionEntry } from "./worktree";

/**
 * Entities layer — a project is a folder the user works on in one tab.
 */
export interface Project {
  readonly id: string;
  readonly path: string;
  readonly name: string;
  /**
   * The name the user gave this tab. `name` stays the folder's, because
   * the tooltip still has to say where the tab actually points.
   */
  readonly label?: string;
  /** Grouping colour for the strip; absent means uncoloured. */
  readonly color?: TabColorId;
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
   * Per-project MCP overrides, by server id. Absent entries follow the
   * provider toggle in settings; an entry pins the server on or off for
   * this project only. Sparse on purpose — a server needed in one repo
   * shouldn't be a fixed per-request cost in every other one.
   */
  readonly mcpOverrides?: ProjectMcpOverrides;
  /**
   * This project's own heavy-folder list for new worktrees. Absent
   * means follow the app default; the same tri-state as mcpOverrides.
   */
  readonly provisioningOverride?: readonly ProvisionEntry[];
  /**
   * When this folder is a linked git worktree, the path of the main
   * checkout it belongs to. Absent for ordinary folders.
   */
  readonly worktreeOf?: string;
  /**
   * When this tab is a subtask, the authority its agent gets. Absent
   * for ordinary tabs; a tab never converts to or from a subtask.
   */
  readonly subtask?: SubtaskScope;
  /**
   * This project's named write-boundary areas, offered when scoping a
   * subtask. Per project because the paths are: `apps/web` describes
   * this repository and means nothing in another one.
   */
  readonly boundaryPresets?: readonly BoundaryPreset[];
}

export function projectNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

/**
 * Longer than the strip could ever show — it ellipsises well before this.
 * A guard on what reaches the workspace file, not a limit the user feels.
 */
export const MAX_TAB_LABEL_LENGTH = 60;

/** What to call a tab: the user's name for it, else its folder's. */
export function tabLabel(project: Project): string {
  return project.label ?? project.name;
}

/**
 * A name as it should be stored, or nothing when the user left it blank.
 * Absent rather than empty because a tab with no name of its own falls
 * back to its folder's, and `""` would win over it.
 */
export function normalizedTabLabel(raw: string): string | undefined {
  return raw.trim().slice(0, MAX_TAB_LABEL_LENGTH) || undefined;
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
  readonly color?: TabColorId;
  readonly provisioningOverride?: readonly ProvisionEntry[];
}

/**
 * What an existing tab would seed a new one with — for opening a
 * worktree beside the tab it was forked from, where the app's global
 * defaults are usually the wrong answer.
 */
export function defaultsFromProject(project: Project): ProjectDefaults {
  return {
    provider: project.provider,
    mode: project.mode,
    permission: project.permission,
    model: project.model,
    effort: project.effort,
    // The colour travels; the name never does. See Worktrees.open.
    color: project.color,
  };
}

export function newProject(
  id: string,
  path: string,
  defaults: ProjectDefaults,
  worktreeOf?: string,
  subtask?: SubtaskScope,
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
    // Only when set: absent means "follow the app default", and a key
    // holding undefined would read as a decision that was never made.
    ...(defaults.provisioningOverride
      ? { provisioningOverride: defaults.provisioningOverride }
      : {}),
    ...(defaults.color ? { color: defaults.color } : {}),
    worktreeOf,
    ...(subtask ? { subtask } : {}),
  };
}
