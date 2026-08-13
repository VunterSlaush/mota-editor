import type { SessionStats } from "../entities/insights";
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
  /** Full project path, for Insights attribution. Absent on transcripts
   *  saved before this field existed — those fall back to dir-hash
   *  matching against known projects. */
  readonly projectPath?: string;
  /**
   * The PROVIDER's own id for this conversation (Claude's session id, not
   * our local one). `id` above is a local UUID for sessions we started,
   * so it cannot be used to find the vendor's records; this can. Insights
   * joins on it to read billed token usage from the vendor's session log.
   * Absent on transcripts saved before this field existed, and on
   * providers that never report a session id — both fall back to the
   * estimated-cost path.
   */
  readonly providerSessionId?: string;
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
  /**
   * The PROVIDER's id for this conversation, when the transcript recorded
   * one — the only key the agent's own session listing can be matched on
   * (`id` is local). Absent on transcripts saved before this field
   * existed, and on providers that never report a session id.
   */
  readonly providerSessionId?: string;
  /** Absent when the source (native agent history) doesn't report one —
   *  render nothing rather than a fake 0. */
  readonly messageCount?: number;
}

/**
 * One session found in the VENDOR's own store (Claude Code's
 * `~/.claude/projects/…`), metadata only — listable without booting an
 * agent process, which is what lets History show conversations started
 * outside this app (a terminal `claude`, another editor).
 */
export interface ExternalSessionMeta {
  readonly sessionId: string;
  /** First user message, or empty when the log's head held none. */
  readonly title: string;
  /** File mtime — the precise last-message time lives at the tail of a
   *  multi-megabyte log; mtime orders a list without reading it. */
  readonly updatedAtMs: number;
}

export interface TranscriptStore {
  save(projectPath: string, transcript: PersistedTranscript): Promise<void>;
  /** Newest first. */
  list(projectPath: string): Promise<TranscriptMeta[]>;
  /**
   * Per-session stat rows across ALL projects' session dirs (not just
   * one project) for the Insights view. `knownProjects` lets the store
   * map hashed session dirs back to paths for transcripts saved before
   * projectPath was embedded.
   */
  listStats(knownProjects: readonly string[]): Promise<SessionStats[]>;
  /**
   * The vendor's own sessions for this project, newest first — Claude
   * Code only (other vendors' stores are undocumented). Empty when the
   * vendor never wrote a store: external history is an upgrade over the
   * local list, never a prerequisite.
   */
  listExternal(projectPath: string): Promise<ExternalSessionMeta[]>;
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
