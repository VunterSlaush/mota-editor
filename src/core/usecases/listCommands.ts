import { BUILTIN_COMMANDS, type CommandInfo } from "../entities/command";
import { commandsFromSequences } from "../entities/commandSequence";
import { commandsFromExtensions } from "../entities/extension";
import type { ProviderId } from "../entities/provider";
import type { CommandCatalog } from "../ports/commandCatalog";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * Use case — the slash commands available in a tab: the user's command
 * sequences and the provider's built-ins, commands contributed by
 * installed extensions (already in state — no I/O), and custom commands
 * discovered in the project and user command folders. Discovery failures
 * degrade to built-ins only. Precedence on a name clash: sequences, then
 * builtins, then extensions, then files. A sequence wins because naming
 * one is the user saying what that name means from now on; the commands
 * Mota answers itself are excluded from sequences upstream, so they are
 * never the ones being displaced.
 */
export class ListCommands {
  constructor(
    private readonly store: Store,
    private readonly commandCatalog: CommandCatalog,
  ) {}

  async execute(tabId: string): Promise<CommandInfo[]> {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab) return [];
    return this.forProvider(tab.project.path, tab.project.provider);
  }

  /**
   * The same list for a provider the tab is NOT currently using — the
   * settings screen configures every provider's commands, not just the
   * one in front of the user.
   */
  async forProvider(path: string, provider: ProviderId): Promise<CommandInfo[]> {
    const state = this.store.getState();
    const sequences = commandsFromSequences(state.settings.commandSequences);
    const builtins = BUILTIN_COMMANDS[provider];
    const extension = commandsFromExtensions(state.extensions, provider);
    const custom = await this.commandCatalog
      .listCustomCommands(path, provider)
      .catch(() => []);

    const seen = new Set(sequences.map((c) => c.name));
    const merged = [...sequences, ...builtins.filter((c) => !seen.has(c.name))];
    for (const c of merged) seen.add(c.name);
    merged.push(...extension.filter((c) => !seen.has(c.name)));
    for (const c of merged) seen.add(c.name);
    merged.push(...custom.filter((c) => !seen.has(c.name)));
    return merged.sort((a, b) => a.name.localeCompare(b.name));
  }
}
