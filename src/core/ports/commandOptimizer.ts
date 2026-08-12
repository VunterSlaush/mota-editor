import type { ProviderId } from "../entities/provider";

/** The analysis run's raw outcome; the verdict inside is parsed by the core. */
export interface OptimizeRun {
  /** The model's reply, verbatim. */
  readonly text: string;
  /** Hash of the command markdown that was analyzed. */
  readonly contentHash: string;
}

/**
 * Ports layer — run one headless AI turn that reads a slash command's
 * markdown and proposes a deterministic script (or declines).
 *
 * Implementations START A PROCESS and take tens of seconds, which is why
 * the settings screen calls this per explicit click and never in the
 * background.
 */
export interface CommandOptimizer {
  optimize(
    projectPath: string,
    provider: ProviderId,
    commandName: string,
  ): Promise<OptimizeRun>;
}
