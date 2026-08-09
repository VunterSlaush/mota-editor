import { useEffect, useState } from "react";
import { MODES, PERMISSIONS } from "../../core/entities/agentSettings";
import type { CommandInfo, CommandSource } from "../../core/entities/command";
import {
  type CommandConfig,
  commandConfigKey,
  isEmptyCommandConfig,
} from "../../core/entities/commandConfig";
import {
  EFFORT_OPTIONS,
  MODEL_SUGGESTIONS,
  PROVIDERS,
  type ProviderId,
} from "../../core/entities/provider";
import type { AppSettings } from "../../core/state/appState";
import { OptionPicker } from "./OptionPicker";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  loadCommands: (provider: ProviderId) => Promise<CommandInfo[]>;
}

/** Empty id = "leave this alone", which is every command's default. */
const INHERIT = "";

/** The origin groups, in display order, with what each one means. */
const SOURCE_GROUPS: readonly { source: CommandSource; label: string; hint: string }[] = [
  { source: "builtin", label: "Native", hint: "The agent's own commands." },
  {
    source: "project",
    label: "Project",
    hint: "From this project's command and skill folders.",
  },
  {
    source: "user",
    label: "User",
    hint: "From the command folders in your home directory.",
  },
];

/**
 * UI — what each slash command does to its tab. Picking a value here
 * means running that command switches the tab to it and leaves it there.
 */
export function SettingsCommands({ settings, onChange, loadCommands }: Props) {
  const [provider, setProvider] = useState<ProviderId>(settings.defaultProvider);
  const [commands, setCommands] = useState<readonly CommandInfo[]>([]);
  const efforts = EFFORT_OPTIONS[provider];
  const models = MODEL_SUGGESTIONS[provider];

  useEffect(() => {
    let cancelled = false;
    loadCommands(provider).then((loaded) => {
      if (!cancelled) setCommands(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [provider, loadCommands]);

  const configFor = (name: string): CommandConfig =>
    settings.commandConfigs[commandConfigKey(provider, name)] ?? {};

  const update = (name: string, change: CommandConfig) => {
    const key = commandConfigKey(provider, name);
    const merged = { ...configFor(name), ...change };
    const next = { ...settings.commandConfigs };
    // An all-inherit row is an absent row: nothing to persist or explain.
    if (isEmptyCommandConfig(merged)) delete next[key];
    else next[key] = merged;
    onChange({ commandConfigs: next });
  };

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Commands</h2>
      <p className="settings-section__hint">
        Give a command the setup it needs. Running it switches the tab to these and leaves
        it there — the toolbar under the message box will move to match.
      </p>
      <p className="settings-section__hint">
        Model and effort only apply before a conversation starts: changing either restarts
        the agent, which re-sends the whole conversation. Pin a cheap model on mechanical
        commands to spend less on them.
      </p>

      <div className="settings-field">
        <div className="settings-field__text">
          <span className="settings-field__label">Provider</span>
          <span className="settings-field__hint">
            Commands differ per agent, so each keeps its own settings.
          </span>
        </div>
        <div className="settings-field__control">
          <OptionPicker
            ariaLabel="Provider whose commands are shown"
            placement="bottom"
            disabled={false}
            value={provider}
            options={PROVIDERS.map((p) => ({ id: p.id, label: p.displayName }))}
            onChange={setProvider}
          />
        </div>
      </div>

      {commands.length === 0 && (
        <p className="settings-section__hint">No commands found for this provider yet.</p>
      )}

      {SOURCE_GROUPS.map((group) => {
        const grouped = commands.filter((c) => c.source === group.source);
        if (grouped.length === 0) return null;
        return (
          <section key={group.source} aria-label={`${group.label} commands`}>
            <div className="command-group">
              <span className="command-group__label">{group.label}</span>
              <span className="command-group__hint">{group.hint}</span>
            </div>
            {grouped.map((command) => (
              <div className="command-row" key={command.name}>
                <div className="command-row__text">
                  <span className="command-row__name">{command.name}</span>
                  <span className="command-row__description">{command.description}</span>
                </div>
                <div className="command-row__controls">
                  <OptionPicker
                    ariaLabel={`Mode for ${command.name}`}
                    placement="bottom"
                    className="command-row__picker"
                    disabled={false}
                    placeholder="Mode"
                    value={configFor(command.name).mode ?? INHERIT}
                    options={[
                      { id: INHERIT, label: "Leave as is" },
                      ...MODES.map((m) => ({ id: m.id, label: m.label })),
                    ]}
                    onChange={(mode) => update(command.name, { mode: mode || undefined })}
                  />
                  <OptionPicker
                    ariaLabel={`Permissions for ${command.name}`}
                    placement="bottom"
                    className="command-row__picker"
                    disabled={false}
                    placeholder="Permissions"
                    value={configFor(command.name).permission ?? INHERIT}
                    options={[
                      { id: INHERIT, label: "Leave as is" },
                      ...PERMISSIONS.map((p) => ({ id: p.id, label: p.label })),
                    ]}
                    onChange={(permission) =>
                      update(command.name, { permission: permission || undefined })
                    }
                  />
                  <OptionPicker
                    ariaLabel={`Model for ${command.name}`}
                    placement="bottom"
                    className="command-row__picker"
                    disabled={false}
                    placeholder="Model"
                    value={configFor(command.name).model ?? INHERIT}
                    options={[
                      { id: INHERIT, label: "Leave as is" },
                      ...models.map((model) => ({ id: model, label: model })),
                    ]}
                    onChange={(model) =>
                      update(command.name, { model: model || undefined })
                    }
                  />
                  {efforts.length > 0 && (
                    <OptionPicker
                      ariaLabel={`Effort for ${command.name}`}
                      placement="bottom"
                      className="command-row__picker"
                      disabled={false}
                      placeholder="Effort"
                      value={configFor(command.name).effort ?? INHERIT}
                      options={[
                        { id: INHERIT, label: "Leave as is" },
                        ...efforts.map((effort) => ({ id: effort, label: effort })),
                      ]}
                      onChange={(effort) =>
                        update(command.name, { effort: effort || undefined })
                      }
                    />
                  )}
                </div>
              </div>
            ))}
          </section>
        );
      })}
    </div>
  );
}
