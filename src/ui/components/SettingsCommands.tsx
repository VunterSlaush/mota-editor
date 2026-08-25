import { ArrowBendUpRight, Chat, WarningCircle } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { MODES, PERMISSIONS } from "../../core/entities/agentSettings";
import type { CommandInfo, CommandSource } from "../../core/entities/command";
import {
  type CommandConfig,
  commandConfigKey,
  isEmptyCommandConfig,
} from "../../core/entities/commandConfig";
import {
  type CommandTokenRow,
  delegationSaving,
  type InsightsRange,
  type InsightsReport,
} from "../../core/entities/insights";
import {
  EFFORT_OPTIONS,
  MODEL_SUGGESTIONS,
  PROVIDERS,
  type ProviderId,
} from "../../core/entities/provider";
import {
  isNeverDelegated,
  type SubagentInfo,
  subagentExists,
} from "../../core/entities/subagent";
import { formatTokens } from "../../core/entities/tokens";
import type { AppSettings } from "../../core/state/appState";
import { OptionPicker } from "./OptionPicker";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  loadCommands: (provider: ProviderId) => Promise<CommandInfo[]>;
  loadSubagents: (provider: ProviderId) => Promise<SubagentInfo[]>;
  loadInsights: (range: InsightsRange) => Promise<InsightsReport>;
}

/**
 * What delegating a command actually bought, from the saved sessions.
 *
 * Only rendered once a command has run BOTH ways: the whole point is the
 * comparison, and a number with nothing to compare against would be a
 * claim rather than a measurement. Run counts are always shown beside
 * the percentage so a lopsided sample reads as one.
 */
function DelegationSaving({ row }: { row: CommandTokenRow }) {
  const saving = delegationSaving(row);
  if (saving === null) return null;

  const perRun = (split: { turns: number; tokens: number }) =>
    formatTokens(Math.round(split.tokens / split.turns));
  const percent = Math.round(Math.abs(saving) * 100);
  const approx = row.estimated ? "≈" : "";

  return (
    <span
      className={`command-row__saving ${
        saving > 0 ? "command-row__saving--cheaper" : "command-row__saving--dearer"
      }`}
    >
      {saving > 0 ? `${percent}% cheaper delegated` : `${percent}% dearer delegated`}
      <span className="command-row__saving-detail">
        {` — ${approx}${perRun(row.delegated)}/run over ${row.delegated.turns} vs `}
        {`${approx}${perRun(row.inChat)} over ${row.inChat.turns} in chat`}
      </span>
    </span>
  );
}

/** Empty id = "leave this alone", which is every command's default. */
const INHERIT = "";

/** The savings line for one command, when there is one to show. */
function savingsFor(rows: readonly CommandTokenRow[], command: string) {
  const row = rows.find((r) => r.command === command);
  return row ? <DelegationSaving row={row} /> : null;
}

/**
 * The configured sub-agent as a picker option when it is no longer among
 * the discovered ones — deleted, renamed, or written for another
 * machine. Shown so the row states its own broken setting rather than
 * looking untouched.
 */
function missingAgent(configured: string | undefined, known: readonly SubagentInfo[]) {
  if (!configured || subagentExists(known, configured)) return [];
  return [
    {
      id: configured,
      label: configured,
      description: "Not found. This command will not run until you choose another.",
      icon: <WarningCircle size={14} />,
    },
  ];
}

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
export function SettingsCommands({
  settings,
  onChange,
  loadCommands,
  loadSubagents,
  loadInsights,
}: Props) {
  const [provider, setProvider] = useState<ProviderId>(settings.defaultProvider);
  const [commands, setCommands] = useState<readonly CommandInfo[]>([]);
  const [subagents, setSubagents] = useState<readonly SubagentInfo[]>([]);
  const [savings, setSavings] = useState<readonly CommandTokenRow[]>([]);
  const efforts = EFFORT_OPTIONS[provider];
  const models = MODEL_SUGGESTIONS[provider];

  // Reading every saved session is not free, so it is only done for
  // someone who actually delegates something — otherwise there is
  // nothing here to measure and no reason to make them wait for it.
  const delegatesAnything = Object.values(settings.commandConfigs).some((c) => c.agent);

  useEffect(() => {
    if (!delegatesAnything) {
      setSavings([]);
      return;
    }
    let cancelled = false;
    loadInsights("all")
      .then((report) => {
        if (!cancelled) setSavings(report.tokens.byCommand);
      })
      .catch(() => undefined); // a measurement nobody asked for stays quiet
    return () => {
      cancelled = true;
    };
  }, [delegatesAnything, loadInsights]);

  useEffect(() => {
    let cancelled = false;
    loadCommands(provider).then((loaded) => {
      if (!cancelled) setCommands(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [provider, loadCommands]);

  useEffect(() => {
    let cancelled = false;
    loadSubagents(provider).then((loaded) => {
      if (!cancelled) setSubagents(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [provider, loadSubagents]);

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
        the agent, which re-sends the whole conversation.
      </p>
      <p className="settings-section__hint">
        <strong>Runs in</strong> decides where the work happens. In this chat is normal.
        Choose a sub-agent instead and the command goes to a separate agent that reads and
        edits on its own and sends back only the result — what it read never enters this
        conversation, so every message after it costs less.
      </p>
      <p className="settings-section__hint">
        Sub-agents are the ones your agent ships with, plus any you have written in its
        agents folder. Mota only reads them, so a sub-agent is also where you pin a
        cheaper model or a lower effort for a command: put it in that sub-agent's own
        definition.
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
                  {savingsFor(savings, command.name)}
                </div>
                <div className="command-row__controls">
                  <OptionPicker
                    ariaLabel={`Mode for ${command.name}`}
                    placement="bottom"
                    align="end"
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
                    align="end"
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
                    align="end"
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
                      align="end"
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
                  {/* Commands Mota answers itself, and the one that
                      compacts THIS conversation, have nowhere else to
                      run — offering the choice would be offering a
                      setting that quietly does nothing. */}
                  {!isNeverDelegated(provider, command.name) && (
                    <OptionPicker
                      ariaLabel={`Where ${command.name} runs`}
                      placement="bottom"
                      align="end"
                      className="command-row__picker command-row__picker--where"
                      disabled={false}
                      placeholder="Runs in"
                      value={configFor(command.name).agent ?? INHERIT}
                      options={[
                        {
                          id: INHERIT,
                          label: "In this chat",
                          description:
                            "Normal. Everything it reads stays in the conversation.",
                          icon: <Chat size={14} />,
                        },
                        ...subagents.map((agent) => ({
                          id: agent.name,
                          label: agent.name,
                          description: agent.description,
                          icon: <ArrowBendUpRight size={14} />,
                        })),
                        // A name that no longer matches anything would
                        // otherwise fall back to the placeholder and read
                        // as unset — while still being set, and still
                        // refused when the command is run.
                        ...missingAgent(configFor(command.name).agent, subagents),
                      ]}
                      onChange={(agent) =>
                        update(command.name, { agent: agent || undefined })
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
