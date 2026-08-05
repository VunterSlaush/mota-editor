import { Plus, Trash } from "@phosphor-icons/react";
import {
  isEnabledFor,
  isRunnable,
  type McpServerConfig,
  withProviderToggled,
} from "../../core/entities/mcpServer";
import { PROVIDERS } from "../../core/entities/provider";
import type { AppSettings } from "../../core/state/appState";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  newId: () => string;
}

/**
 * UI — MCP servers Mota hands to agents. Deliberately explicit that this
 * is only Mota's half of the picture: the agent also loads whatever its
 * own config says, and ACP gives no way to read that back.
 */
export function SettingsTools({ settings, onChange, newId }: Props) {
  const servers = settings.mcpServers;

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
        </div>
      ))}

      <button type="button" className="tool-add" onClick={add}>
        <Plus size={14} /> Add a server
      </button>
    </div>
  );
}
