import type {
  OptimizationBlocker,
  OptimizationProposal,
  RewriteProposal,
} from "../entities/commandOptimization";
import {
  parseOptimizationVerdict,
  parseRewriteVerdict,
} from "../entities/commandOptimization";
import type { ProviderId } from "../entities/provider";
import type { CommandOptimizer, SavedCommandCopy } from "../ports/commandOptimizer";

/** What the settings row renders after an analysis run. */
export type OptimizeOutcome =
  | {
      readonly kind: "proposal";
      readonly proposal: OptimizationProposal;
      readonly sourceHash: string;
    }
  | { readonly kind: "failed"; readonly error: string };

/** What the settings row renders after a rewrite run. */
export type RewriteOutcome =
  | { readonly kind: "proposal"; readonly proposal: RewriteProposal }
  | { readonly kind: "failed"; readonly error: string };

/**
 * Use case — analyze one slash command and return a reviewable proposal.
 * Nothing is persisted here: activation is the user's approval writing
 * the settings map, and a discarded proposal must leave no trace.
 */
export class OptimizeCommand {
  constructor(private readonly optimizer: CommandOptimizer) {}

  async execute(
    projectPath: string,
    provider: ProviderId,
    commandName: string,
  ): Promise<OptimizeOutcome> {
    let run: { text: string; contentHash: string };
    try {
      run = await this.optimizer.optimize(projectPath, provider, commandName);
    } catch (error) {
      return { kind: "failed", error: String(error) };
    }
    const verdict = parseOptimizationVerdict(run.text);
    if (verdict.kind === "invalid") {
      return { kind: "failed", error: verdict.error };
    }
    return { kind: "proposal", proposal: verdict.proposal, sourceHash: run.contentHash };
  }

  /**
   * Second chance for a declined command: rewrite it into an optimizable
   * variant, applying the stored blockers' advice. Proposes only — the
   * copy reaches disk through `saveCopy` after the user's review.
   */
  async rewrite(
    projectPath: string,
    provider: ProviderId,
    commandName: string,
    blockers: readonly OptimizationBlocker[],
  ): Promise<RewriteOutcome> {
    let run: { text: string };
    try {
      run = await this.optimizer.rewrite(projectPath, provider, commandName, blockers);
    } catch (error) {
      return { kind: "failed", error: String(error) };
    }
    const verdict = parseRewriteVerdict(run.text);
    if (verdict.kind === "invalid") {
      return { kind: "failed", error: verdict.error };
    }
    return { kind: "proposal", proposal: verdict.proposal };
  }

  /** Write the approved variant to disk as a NEW command file. */
  async saveCopy(
    projectPath: string,
    provider: ProviderId,
    sourceName: string,
    content: string,
  ): Promise<SavedCommandCopy> {
    return this.optimizer.saveCopy(projectPath, provider, sourceName, content);
  }
}
