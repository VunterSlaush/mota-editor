import { BUILTIN_COMMANDS, type CommandInfo } from "../entities/command";
import type { CommandCatalog } from "../ports/commandCatalog";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * Use case — the slash commands available in a tab: the provider's
 * built-ins plus custom commands discovered in the project and user
 * command folders. Discovery failures degrade to built-ins only.
 */
export class ListCommands {
  constructor(
    private readonly store: Store,
    private readonly commandCatalog: CommandCatalog,
  ) {}

  async execute(tabId: string): Promise<CommandInfo[]> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return [];

    const { provider, path } = tab.project;
    const builtins = BUILTIN_COMMANDS[provider];
    const custom = await this.commandCatalog
      .listCustomCommands(path, provider)
      .catch(() => []);

    const seen = new Set(builtins.map((c) => c.name));
    const merged = [...builtins, ...custom.filter((c) => !seen.has(c.name))];
    return merged.sort((a, b) => a.name.localeCompare(b.name));
  }
}
