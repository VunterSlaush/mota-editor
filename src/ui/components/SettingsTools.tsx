import { Gauge, Plus, Trash } from "@phosphor-icons/react";
import { useState } from "react";
import {
  isEnabledFor,
  isEnabledForProject,
  isRunnable,
  type McpServerConfig,
  withProviderToggled,
} from "../../core/entities/mcpServer";
import { tabLabel } from "../../core/entities/project";
import { PROVIDERS } from "../../core/entities/provider";
import { formatTokens } from "../../core/entities/tokens";
import type { McpProbe, McpProbeResult } from "../../core/ports/mcpProbe";
import type { AppSettings, TabState } from "../../core/state/appState";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  newId: () => string;
  /** The tab whose per-project overrides are edited here; null with no
   *  project open, which hides the per-project column. */
  activeTab: TabState | null;
  mcpProbe: McpProbe;
  onOverrideChange: (serverId: string, enabled: boolean | undefined) => void;
}

/**
 * UI — MCP servers Mota hands to agents. Deliberately explicit that this
 * is only Mota's half of the picture: the agent also loads whatever its
 * own config says, and ACP gives no way to read that back.
 */
export function SettingsTools({
  settings,
  onChange,
  newId,
  activeTab,
  mcpProbe,
  onOverrideChange,
}: Props) {
  const servers = settings.mcpServers;
  // Measured on request, not on open: each probe starts a real process.
  const [measured, setMeasured] = useState<Record<string, McpProbeResult>>({});
  const [measuring, setMeasuring] = useState(false);

  const measureAll = async () => {
    setMeasuring(true);
    const runnable = servers.filter(isRunnable);
    const results = await Promise.all(
      runnable.map((server) =>
        mcpProbe
          .probe({
            name: server.name,
            command: server.command,
            args: server.args,
            env: server.env,
          })
          .then((result) => [server.id, result] as const),
      ),
    );
    setMeasured(Object.fromEntries(results));
    setMeasuring(false);
  };

  const replace = (next: readonly McpServerConfig[]) => onChange({ mcpServers: next });

  const update = (id: string, change: Partial<McpServerConfig>) =>
    replace(servers.map((s) => (s.id === id ? { ...s, ...change } : s)));

  const add = () =>
    replace([
      ...servers,
      {
        id: newId(),
        name: "",
        command: "",
        args: [],
        env: {},
        enabledFor: [settings.defaultProvider],
      },
    ]);

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Tools</h2>
      <p className="settings-section__hint">
        MCP servers Mota starts with each agent session. This lists what Mota adds — the
        agent also loads the servers configured in its own CLI, and the protocol gives no
        way to read those back here. Changing a server restarts the tab's session, because
        servers are fixed when a session opens.
      </p>

      <p className="settings-section__hint">
        Every enabled server's tool definitions sit in the cached prefix of every request
        for the whole session — a fixed cost whether or not the agent uses them. Measuring
        starts each server briefly to ask what it offers.
      </p>

      {servers.length > 0 && (
        <button
          type="button"
          className="tool-add"
          onClick={() => void measureAll()}
          disabled={measuring}
        >
          <Gauge size={14} /> {measuring ? "Measuring…" : "Measure tool cost"}
        </button>
      )}

      {servers.length === 0 && <p className="settings-section__hint">No servers yet.</p>}

      {servers.map((server) => (
        <div className="tool-row" key={server.id}>
          <div className="tool-row__fields">
            <input
              className="settings-input"
              placeholder="Name (e.g. filesystem)"
              value={server.name}
              onChange={(e) => update(server.id, { name: e.target.value })}
            />
            <input
              className="settings-input"
              placeholder="Command (e.g. npx)"
              value={server.command}
              onChange={(e) => update(server.id, { command: e.target.value })}
            />
            <input
              className="settings-input"
              placeholder="Arguments, space separated"
              value={server.args.join(" ")}
              onChange={(e) =>
                update(server.id, { args: e.target.value.split(/\s+/).filter(Boolean) })
              }
            />
          </div>
          <div className="tool-row__side">
            <div className="tool-row__providers">
              {PROVIDERS.map((provider) => (
                <label className="tool-row__toggle" key={provider.id}>
                  <input
                    type="checkbox"
                    checked={isEnabledFor(server, provider.id)}
                    onChange={(e) =>
                      update(
                        server.id,
                        withProviderToggled(server, provider.id, e.target.checked),
                      )
                    }
                  />
                  {provider.displayName}
                </label>
              ))}
            </div>
            <button
              type="button"
              className="tool-row__remove"
              aria-label={`Remove ${server.name || "server"}`}
              onClick={() => replace(servers.filter((s) => s.id !== server.id))}
            >
              <Trash size={14} />
            </button>
          </div>
          {!isRunnable(server) && (
            <span className="tool-row__warning">
              Needs a name and a command before it is sent to any agent.
            </span>
          )}
          <ToolCost result={measured[server.id]} />
          {activeTab && (
            <ProjectOverride
              server={server}
              tab={activeTab}
              onChange={(enabled) => onOverrideChange(server.id, enabled)}
            />
          )}
        </div>
      ))}

      <button type="button" className="tool-add" onClick={add}>
        <Plus size={14} /> Add a server
      </button>
    </div>
  );
}

/** What this server adds to every request, once measured. */
function ToolCost({ result }: { result: McpProbeResult | undefined }) {
  if (!result) return null;
  if (result.error !== undefined) {
    return <span className="tool-row__warning">{result.error}</span>;
  }
  if (!result.inventory) return null;
  const { toolCount, prefixTokens } = result.inventory;
  return (
    <span className="tool-row__cost">
      {toolCount} {toolCount === 1 ? "tool" : "tools"} · ~{formatTokens(prefixTokens)}{" "}
      tokens of every request
    </span>
  );
}

/**
 * This project's override for one server. Three states, not two: the
 * middle one follows the provider toggle, which is what almost every row
 * should do — an override is for the exception.
 */
function ProjectOverride({
  server,
  tab,
  onChange,
}: {
  server: McpServerConfig;
  tab: TabState;
  onChange: (enabled: boolean | undefined) => void;
}) {
  const provider = tab.project.provider;
  const override = tab.project.mcpOverrides?.[server.id];
  const effective = isEnabledForProject(server, provider, tab.project.mcpOverrides);
  const followsDefault = isEnabledFor(server, provider) ? "on" : "off";
  return (
    <div className="tool-row__project">
      <span className="tool-row__project-label">
        In {tabLabel(tab.project)}: <strong>{effective ? "on" : "off"}</strong>
      </span>
      <div className="tool-row__project-choices">
        {(
          [
            [undefined, `Follow default (${followsDefault})`],
            [true, "On"],
            [false, "Off"],
          ] as const
        ).map(([value, label]) => (
          <label className="tool-row__toggle" key={label}>
            <input
              type="radio"
              name={`override-${server.id}`}
              checked={override === value}
              onChange={() => onChange(value)}
            />
            {label}
          </label>
        ))}
      </div>
    </div>
  );
}
