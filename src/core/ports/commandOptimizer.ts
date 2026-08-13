import type { OptimizationBlocker } from "../entities/commandOptimization";
import type { ProviderId } from "../entities/provider";

/** The analysis run's raw outcome; the verdict inside is parsed by the core. */
export interface OptimizeRun {
  /** The model's reply, verbatim. */
  readonly text: string;
  /** Hash of the command markdown that was analyzed. */
  readonly contentHash: string;
}

/** A rewritten command variant written to disk as a new file. */
export interface SavedCommandCopy {
  /** The new command's slash name, e.g. "/start-preview-optimized". */
  readonly name: string;
  /** Hash of the written file — the new record's sourceHash. */
  readonly contentHash: string;
}

/**
 * Ports layer — run one headless AI turn that reads a slash command's
 * markdown and proposes a deterministic script (or declines).
 *
 * `optimize` and `rewrite` START A PROCESS and take tens of seconds,
 * which is why the settings screen calls them per explicit click and
 * never in the background. `saveCopy` writes a NEW command file next to
 * the source and must refuse to overwrite anything.
 */
export interface CommandOptimizer {
  optimize(
    projectPath: string,
    provider: ProviderId,
    commandName: string,
  ): Promise<OptimizeRun>;
  rewrite(
    projectPath: string,
    provider: ProviderId,
    commandName: string,
    blockers: readonly OptimizationBlocker[],
  ): Promise<OptimizeRun>;
  saveCopy(
    projectPath: string,
    provider: ProviderId,
    sourceName: string,
    content: string,
  ): Promise<SavedCommandCopy>;
}
