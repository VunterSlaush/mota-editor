import { invoke } from "@tauri-apps/api/core";
import type { OptimizationBlocker } from "../../core/entities/commandOptimization";
import type { ProviderId } from "../../core/entities/provider";
import type {
  CommandOptimizer,
  OptimizeRun,
  SavedCommandCopy,
} from "../../core/ports/commandOptimizer";

/** Wire shape returned by the Rust backend (`optimize_command`). */
interface WireOptimizeRun {
  text: string;
  contentHash: string;
}

/** Wire shape returned by `save_command_copy`. */
interface WireSavedCopy {
  name: string;
  contentHash: string;
}

/**
 * Interface adapter — asks the backend to run one headless analysis
 * turn over a slash command's markdown, and to write approved variants
 * next to their source.
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

  async rewrite(
    projectPath: string,
    provider: ProviderId,
    commandName: string,
    blockers: readonly OptimizationBlocker[],
  ): Promise<OptimizeRun> {
    const wire = await invoke<WireOptimizeRun>("rewrite_command", {
      projectPath,
      providerId: provider,
      commandName,
      blockers,
    });
    return { text: wire.text, contentHash: wire.contentHash };
  }

  async saveCopy(
    projectPath: string,
    provider: ProviderId,
    sourceName: string,
    content: string,
  ): Promise<SavedCommandCopy> {
    const wire = await invoke<WireSavedCopy>("save_command_copy", {
      projectPath,
      providerId: provider,
      sourceName,
      content,
    });
    return { name: wire.name, contentHash: wire.contentHash };
  }
}
