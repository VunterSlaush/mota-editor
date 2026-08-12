import type { OptimizationProposal } from "../entities/commandOptimization";
import { parseOptimizationVerdict } from "../entities/commandOptimization";
import type { ProviderId } from "../entities/provider";
import type { CommandOptimizer } from "../ports/commandOptimizer";

/** What the settings row renders after an analysis run. */
export type OptimizeOutcome =
  | {
      readonly kind: "proposal";
      readonly proposal: OptimizationProposal;
      readonly sourceHash: string;
    }
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
}
