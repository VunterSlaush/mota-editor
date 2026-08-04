import type { CommandInfo } from "../entities/command";
import type { ProviderId } from "../entities/provider";

/**
 * Ports layer — boundary for discovering a provider's custom slash
 * commands (project and user command folders). Built-ins are static
 * domain data; only discovery needs the outside world.
 */
export interface CommandCatalog {
  listCustomCommands(projectPath: string, provider: ProviderId): Promise<CommandInfo[]>;
}
