import type { AgentMode, PermissionPolicy } from "../entities/agentSettings";
import type { ProviderId } from "../entities/provider";

/**
 * Ports layer — persistence and OS-interaction boundaries.
 * Owned by the core; implemented at the edges.
 */

/** Snapshot of the workspace that survives restarts. */
export interface PersistedProject {
  readonly id: string;
  readonly path: string;
  readonly provider: ProviderId;
  readonly mode?: AgentMode;
  readonly permission?: PermissionPolicy;
  readonly model?: string;
  readonly effort?: string;
  readonly verbose?: boolean;
  readonly providerSessions: Readonly<Partial<Record<ProviderId, string>>>;
}

export interface PersistedWorkspace {
  readonly projects: readonly PersistedProject[];
  readonly activeTabId: string | null;
  readonly settings?: { readonly defaultProvider?: ProviderId };
}

export interface WorkspaceStore {
  load(): Promise<PersistedWorkspace | null>;
  save(workspace: PersistedWorkspace): Promise<void>;
}

export interface FolderPicker {
  /** Returns the chosen folder path, or null if the user cancelled. */
  pickFolder(): Promise<string | null>;
}

export interface FilePicker {
  /** Returns the chosen file paths; empty if the user cancelled. */
  pickFiles(): Promise<string[]>;
}
