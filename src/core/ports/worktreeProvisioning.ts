import type { ProvisionEntry, ProvisionStrategy } from "../entities/worktree";

/**
 * Ports layer — stocking a worktree with the folders git does not carry,
 * and reporting what that costs. Separate from `GitPort` on purpose:
 * none of it is git's work, and none of it goes through the git CLI.
 */

/** What became of one folder. Failure here never fails the worktree. */
export interface EntryOutcome {
  readonly path: string;
  readonly strategy: ProvisionStrategy;
  /** "linked" | "copied" | "skipped" | "already" | "failed" */
  readonly outcome: string;
  /** Why, when there is something worth saying. */
  readonly message: string;
}

export interface ProvisionReport {
  readonly worktreePath: string;
  readonly entries: readonly EntryOutcome[];
  /** True when nothing failed. Skipping is not failing. */
  readonly ok: boolean;
}

/** One folder's share of a worktree's size. */
export interface UsageEntry {
  readonly path: string;
  readonly bytes: number;
  readonly shared: boolean;
}

/**
 * What a worktree costs. `sharedBytes` is what it got from the main
 * checkout — attributed from what was linked or copied, not measured:
 * a copy-on-write clone costs almost nothing and still reports full size.
 */
export interface DiskUsage {
  readonly ownBytes: number;
  readonly sharedBytes: number;
  readonly apparentBytes: number;
  readonly entries: readonly UsageEntry[];
  /** The walk stopped early; every number is a lower bound. */
  readonly truncated: boolean;
}

export interface WorktreeProvisioning {
  /** Stock a worktree. Rejects only on a malformed request. */
  provision(
    mainPath: string,
    worktreePath: string,
    entries: readonly ProvisionEntry[],
  ): Promise<ProvisionReport>;
  /** Remove the links a worktree was given; resolves with what went. */
  unprovision(worktreePath: string, paths: readonly string[]): Promise<string[]>;
  /** Whether this disk copies without duplicating the bytes. */
  supportsCow(path: string): Promise<boolean>;
  /**
   * Folders inside a project that could be provisioned, repo-relative —
   * what the settings section offers as suggestions. Read off the disk
   * rather than from git, because the folders worth naming are the ones
   * git ignores.
   */
  folderCandidates(projectPath: string): Promise<string[]>;
  /** Size on disk, with the shared folders counted apart. */
  diskUsage(worktreePath: string, sharedPaths: readonly string[]): Promise<DiskUsage>;
}
