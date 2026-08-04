import { PROVIDERS, type ProviderId } from "../../core/entities/provider";

interface Props {
  defaultProvider: ProviderId;
  onChangeDefaultProvider: (provider: ProviderId) => void;
}

/** UI — app settings. Per-tab settings live in the composer toolbar. */
export function SettingsPanel({ defaultProvider, onChangeDefaultProvider }: Props) {
  return (
    <aside className="settings">
      <h3 className="changes__title">Defaults</h3>
      <label className="settings__field">
        <span className="settings__label">Provider for new projects</span>
        <select
          className="changes__branch"
          value={defaultProvider}
          onChange={(e) => onChangeDefaultProvider(e.target.value as ProviderId)}
        >
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.displayName}
            </option>
          ))}
        </select>
      </label>

      <h3 className="changes__title">Faster agent startup</h3>
      <p className="settings__hint">
        Install the interactive agents globally so sessions start instantly:
      </p>
      <code className="settings__code">
        npm i -g @agentclientprotocol/claude-agent-acp{"\n"}
        npm i -g @agentclientprotocol/codex-acp{"\n"}
        npm i -g @google/gemini-cli
      </code>

      <h3 className="changes__title">Per-tab settings</h3>
      <p className="settings__hint">
        Model, effort, mode, and permissions are set per tab, in the toolbar
        under the message box. Verbose and provider are in the tab header.
      </p>
    </aside>
  );
}
