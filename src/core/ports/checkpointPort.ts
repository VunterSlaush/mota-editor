/**
 * Ports layer — boundary for the snapshots `/rewind` restores from. The
 * core cares about "give me something to come back to" and "put the
 * files back"; how that is stored is the adapter's business.
 */

/** What rewinding will do to one path. */
export type CheckpointFate = "restore" | "delete";

export interface CheckpointChange {
  readonly path: string;
  readonly fate: CheckpointFate;
  /** What happened to it since the checkpoint: added, deleted, modified. */
  readonly label: string;
}

export interface CheckpointStat {
  readonly files: number;
  readonly insertions: number;
  readonly deletions: number;
}

export interface CheckpointPreview {
  readonly changes: readonly CheckpointChange[];
  readonly stat: CheckpointStat;
}

export interface CheckpointPort {
  /**
   * Can this project be checkpointed at all? False turns the feature off
   * rather than offering a rewind that would only half work.
   */
  available(projectPath: string): Promise<boolean>;
  /**
   * Snapshot the project as it is right now and resolve with an opaque
   * handle to come back to. `sessionId` only groups a conversation's
   * checkpoints together so they can be dropped as a set.
   */
  create(projectPath: string, sessionId: string): Promise<string>;
  /** What rewinding to this checkpoint would change. */
  preview(projectPath: string, checkpoint: string): Promise<CheckpointPreview>;
  /** Put the files back. Resolves with the paths that were touched. */
  restore(projectPath: string, checkpoint: string): Promise<readonly string[]>;
  /** A unified diff for one file, checkpoint versus now. */
  fileDiff(projectPath: string, checkpoint: string, path: string): Promise<string>;
  /** Drop a conversation's checkpoints. Best-effort; never throws. */
  forget(projectPath: string, sessionId: string): Promise<void>;
}
