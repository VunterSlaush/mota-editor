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
 * One exception, and it is deliberate: a field whose change can only
 * take hold by RESPAWNING the agent (effort is env-based over ACP) is
 * skipped once a conversation exists — the respawn makes the next turn
 * re-ingest the whole conversation, and saving those tokens outranks
 * honouring the command's preference. The command then simply runs
 * under the session's current setup, and the toolbar (truthfully)
 * doesn't move.
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

    // Only fields that actually differ are applied: SelectEffort
    // respawns the tab's agent session (effort is env-based over ACP),
    // so re-running a command with the setup already in place must cost
    // nothing.
    if (config.mode && config.mode !== tab.project.mode) {
      await this.selectMode.execute(tabId, config.mode);
    }
    if (config.permission && config.permission !== tab.project.permission) {
      await this.selectPermission.execute(tabId, config.permission);
    }
    if (
      config.effort !== undefined &&
      config.effort !== (tab.project.effort ?? "") &&
      // A conversation in flight makes the effort respawn too expensive
      // (see the class comment); before the first turn it is free.
      !tab.project.providerSessions[tab.project.provider]
    ) {
      await this.selectEffort.execute(tabId, config.effort);
    }
  }
}
