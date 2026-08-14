import type {
  AgentMode,
  AutoCompactPolicy,
  PermissionPolicy,
} from "../entities/agentSettings";
import type { CommandConfig } from "../entities/commandConfig";
import type { McpServerConfig, ProjectMcpOverrides } from "../entities/mcpServer";
import type { ProviderId } from "../entities/provider";
import type { ProvisionEntry, WorktreeSettings } from "../entities/worktree";

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
  /** The name the user gave this tab, if any. */
  readonly label?: string;
  /**
   * Grouping colour id. A plain string, not `TabColorId`: this comes out
   * of a file, so whether it still names a colour is decided by the guard
   * at restore rather than asserted by the type.
   */
  readonly color?: string;
  readonly verbose?: boolean;
  readonly providerSessions: Readonly<Partial<Record<ProviderId, string>>>;
  /**
   * The transcript this tab's chat was writing to. Restored so that a
   * conversation the agent is STILL in keeps appending to its own
   * history entry instead of starting one per app run.
   */
  readonly historySessionId?: string;
  /** Per-project MCP on/off overrides, by server id. */
  readonly mcpOverrides?: ProjectMcpOverrides;
  /** This project's own worktree heavy-folder list; absent follows the default. */
  readonly provisioningOverride?: readonly ProvisionEntry[];
  /** Main-checkout path when this project is a linked git worktree. */
  readonly worktreeOf?: string;
}

/**
 * App-wide preferences as written to disk. Every field is optional: a
 * workspace file written by an older build must still load.
 */
export interface PersistedSettings {
  readonly defaultProvider?: ProviderId;
  readonly defaultMode?: AgentMode;
  readonly defaultPermission?: PermissionPolicy;
  readonly defaultModel?: Readonly<Partial<Record<ProviderId, string>>>;
  readonly defaultEffort?: Readonly<Partial<Record<ProviderId, string>>>;
  readonly commandConfigs?: Readonly<Record<string, CommandConfig>>;
  readonly mcpServers?: readonly McpServerConfig[];
  readonly autoCompactThreshold?: number;
  readonly autoCompact?: AutoCompactPolicy;
  readonly theme?: string;
  readonly zoomLevel?: number;
  /** Partial too: a field added after this file was written is defaulted. */
  readonly worktrees?: Partial<WorktreeSettings>;
  readonly terminalShell?: string;
  readonly terminalFontSize?: number;
  readonly terminalSuggestions?: boolean;
}

export interface PersistedWorkspace {
  readonly projects: readonly PersistedProject[];
  readonly activeTabId: string | null;
  readonly settings?: PersistedSettings;
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

export interface PastedImageStore {
  /**
   * Persist image bytes pasted into the composer and return the saved
   * file's full path. Attachments travel as paths everywhere (chips,
   * queue, transcript, agent prompt), so a paste becomes a file first.
   */
  saveImage(bytes: Uint8Array, mimeType: string): Promise<string>;
}
