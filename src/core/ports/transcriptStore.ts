import type { ChatMessage } from "../entities/message";
import type { PlanEntry } from "../entities/plan";
import type { ProviderId } from "../entities/provider";

/**
 * Ports layer — persistence boundary for conversation transcripts,
 * stored per project so previous sessions can be reopened.
 */
export interface PersistedTranscript {
  readonly id: string;
  readonly title: string;
  readonly savedAt: number;
  readonly provider: ProviderId;
  readonly messages: readonly ChatMessage[];
  /** The agent's structured plan at save time, when any (small). */
  readonly plan?: readonly PlanEntry[];
  /**
   * PATH of the plan file the agent saved (plan-mode plans) — the
   * content is read from disk when the session is reopened, so
   * transcripts stay small and plans are never duplicated per session.
   */
  readonly planFilePath?: string;
}

export interface TranscriptMeta {
  readonly id: string;
  readonly title: string;
  readonly savedAt: number;
  readonly provider: string;
  /** Absent when the source (native agent history) doesn't report one —
   *  render nothing rather than a fake 0. */
  readonly messageCount?: number;
}

export interface TranscriptStore {
  save(projectPath: string, transcript: PersistedTranscript): Promise<void>;
  /** Newest first. */
  list(projectPath: string): Promise<TranscriptMeta[]>;
  load(projectPath: string, id: string): Promise<PersistedTranscript | null>;
  remove(projectPath: string, id: string): Promise<void>;
  /**
   * Content of a plan file by path; null when it no longer exists. The
   * path was recorded from AGENT output, so implementations must confine
   * reads to the project folder (or the agent's own plan directory) —
   * never treat it as a free file-read.
   */
  readPlanFile(projectPath: string, path: string): Promise<string | null>;
}
