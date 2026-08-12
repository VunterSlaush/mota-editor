import { invoke } from "@tauri-apps/api/core";
import type { CommandInfo } from "../../core/entities/command";
import type { ProviderId } from "../../core/entities/provider";
import type { CommandCatalog } from "../../core/ports/commandCatalog";

/** Wire shape returned by the Rust backend (`list_custom_commands`). */
interface WireCommand {
  name: string;
  description: string;
  origin: "project" | "user";
  contentHash?: string;
}

/**
 * Interface adapter — discovers custom slash commands by asking the
 * backend to scan the provider's command folders.
 */
export class TauriCommandCatalog implements CommandCatalog {
  async listCustomCommands(
    projectPath: string,
    provider: ProviderId,
  ): Promise<CommandInfo[]> {
    const wire = await invoke<WireCommand[]>("list_custom_commands", {
      projectPath,
      providerId: provider,
    });
    // A backend from before origins reported nothing — assume "project",
    // the more visible group.
    return wire.map(({ name, description, origin, contentHash }) => ({
      name,
      description,
      source: origin ?? "project",
      ...(contentHash ? { contentHash } : {}),
    }));
  }
}
