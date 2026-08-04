import type { AgentMode, PermissionPolicy } from "./agentSettings";
import { DEFAULT_MODE, DEFAULT_PERMISSION } from "./agentSettings";
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
}

export function projectNameFromPath(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, "");
  const segments = trimmed.split(/[\\/]/);
  return segments[segments.length - 1] || trimmed;
}

export function newProject(id: string, path: string, provider: ProviderId): Project {
  return {
    id,
    path,
    name: projectNameFromPath(path),
    provider,
    mode: DEFAULT_MODE,
    permission: DEFAULT_PERMISSION,
    verbose: true,
    providerSessions: {},
  };
}
