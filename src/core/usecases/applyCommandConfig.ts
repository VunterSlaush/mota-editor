import { commandConfigKey, leadingCommand } from "../entities/commandConfig";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";
import type { SelectEffort, SelectMode, SelectPermission } from "./switchTab";

/**
 * Use case — a slash command carries its own setup, so running it leaves
 * the tab configured the way that command needs. The change is STICKY:
 * the toolbar visibly moves and stays moved, because a setting that
 * silently reverted would be a setting the user cannot trust.
 *
 * Composed from the existing selection use cases rather than dispatching
 * directly, so each field keeps the persistence and session-restart
 * behaviour it already has.
 */
export class ApplyCommandConfig {
  constructor(
    private readonly store: Store,
    private readonly selectMode: SelectMode,
    private readonly selectPermission: SelectPermission,
    private readonly selectEffort: SelectEffort,
  ) {}

  async execute(tabId: string, prompt: string): Promise<void> {
    const tab = tabById(this.store.getState(), tabId);
    const command = leadingCommand(prompt);
    if (!tab || !command) return;

    const key = commandConfigKey(tab.project.provider, command);
    const config = this.store.getState().settings.commandConfigs[key];
    if (!config) return;

    if (config.mode) await this.selectMode.execute(tabId, config.mode);
    if (config.permission) {
      await this.selectPermission.execute(tabId, config.permission);
    }
    if (config.effort !== undefined) {
      await this.selectEffort.execute(tabId, config.effort);
    }
  }
}
