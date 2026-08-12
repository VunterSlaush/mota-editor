import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "../../core/entities/provider";
import type { CommandOptimizer, OptimizeRun } from "../../core/ports/commandOptimizer";

/** Wire shape returned by the Rust backend (`optimize_command`). */
interface WireOptimizeRun {
  text: string;
  contentHash: string;
}

/**
 * Interface adapter — asks the backend to run one headless analysis
 * turn over a slash command's markdown.
 */
export class TauriCommandOptimizer implements CommandOptimizer {
  async optimize(
    projectPath: string,
    provider: ProviderId,
    commandName: string,
  ): Promise<OptimizeRun> {
    const wire = await invoke<WireOptimizeRun>("optimize_command", {
      projectPath,
      providerId: provider,
      commandName,
    });
    return { text: wire.text, contentHash: wire.contentHash };
  }
}
