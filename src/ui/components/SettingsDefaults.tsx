import {
  COST_PRESETS,
  MODES,
  matchingCostPreset,
  PERMISSIONS,
} from "../../core/entities/agentSettings";
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
}

/** The provider whose model and effort the pickers below are editing. */
const UNSET = "";

/**
 * UI — the defaults every NEW tab starts with. Model and effort are
 * edited for the default provider only: they are the one pair of settings
 * whose vocabulary changes per vendor.
 */
export function SettingsDefaults({ settings, onChange }: Props) {
  const provider = settings.defaultProvider;
  const efforts = EFFORT_OPTIONS[provider];

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Defaults for new projects</h2>
      <p className="settings-section__hint">
        Opening a folder starts its tab with these. Tabs already open keep what they have
        — change those in the toolbar under the message box.
      </p>

      <Field label="Provider" hint="Which agent drives a new project's chat.">
        <OptionPicker
          ariaLabel="Default provider"
          placement="bottom"
          disabled={false}
          value={provider}
          options={PROVIDERS.map((p) => ({
            id: p.id,
            label: p.displayName,
            description: p.vendor,
          }))}
          onChange={(defaultProvider: ProviderId) => onChange({ defaultProvider })}
        />
      </Field>

      <Field label="Mode" hint="How the agent behaves when a tab opens.">
        <OptionPicker
          ariaLabel="Default mode"
          placement="bottom"
          disabled={false}
          value={settings.defaultMode}
          options={MODES.map((m) => ({
            id: m.id,
            label: m.label,
            description: m.description,
          }))}
          onChange={(defaultMode) => onChange({ defaultMode })}
        />
      </Field>

      <Field label="Permissions" hint="How much the agent may do without asking.">
        <OptionPicker
          ariaLabel="Default permissions"
          placement="bottom"
          disabled={false}
          value={settings.defaultPermission}
          options={PERMISSIONS.map((p) => ({
            id: p.id,
            label: p.label,
            description: p.description,
          }))}
          onChange={(defaultPermission) => onChange({ defaultPermission })}
        />
      </Field>

      <Field
        label="Cost preset"
        hint="Sets the model and effort below together — the pair is what decides the bill."
      >
        <OptionPicker
          ariaLabel="Cost preset"
          placement="bottom"
          disabled={false}
          placeholder="Custom"
          value={
            matchingCostPreset(
              provider,
              settings.defaultModel[provider],
              settings.defaultEffort[provider],
            ) ?? UNSET
          }
          options={[
            { id: UNSET, label: "Custom", description: "Whatever you set below." },
            ...COST_PRESETS.map((preset) => ({
              id: preset.id,
              label: preset.label,
              description: preset.description,
            })),
          ]}
          onChange={(id) => {
            // "Custom" is what the pickers below produce, not something
            // to apply — selecting it should change nothing.
            const preset = COST_PRESETS.find((p) => p.id === id);
            if (!preset) return;
            onChange({
              defaultModel: withProvider(
                settings.defaultModel,
                provider,
                preset.model[provider],
              ),
              defaultEffort: withProvider(
                settings.defaultEffort,
                provider,
                preset.effort[provider],
              ),
            });
          }}
        />
      </Field>

      <Field
        label="Model"
        hint={`Sent to ${providerName(provider)}. Empty = its own default.`}
      >
        <input
          className="settings-input"
          list="settings-model-suggestions"
          placeholder="Provider default"
          value={settings.defaultModel[provider] ?? UNSET}
          onChange={(e) =>
            onChange({
              defaultModel: withProvider(settings.defaultModel, provider, e.target.value),
            })
          }
        />
        <datalist id="settings-model-suggestions">
          {MODEL_SUGGESTIONS[provider].map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
      </Field>

      {efforts.length > 0 && (
        <Field
          label="Reasoning effort"
          hint="How hard the agent thinks before answering."
        >
          <OptionPicker
            ariaLabel="Default reasoning effort"
            placement="bottom"
            disabled={false}
            placeholder="Provider default"
            value={settings.defaultEffort[provider] ?? UNSET}
            options={[
              { id: UNSET, label: "Provider default" },
              ...efforts.map((effort) => ({ id: effort, label: effort })),
            ]}
            onChange={(effort) =>
              onChange({
                defaultEffort: withProvider(settings.defaultEffort, provider, effort),
              })
            }
          />
        </Field>
      )}
    </div>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-field">
      <div className="settings-field__text">
        <span className="settings-field__label">{label}</span>
        <span className="settings-field__hint">{hint}</span>
      </div>
      <div className="settings-field__control">{children}</div>
    </div>
  );
}

function providerName(provider: ProviderId): string {
  return PROVIDERS.find((p) => p.id === provider)?.displayName ?? provider;
}

/** A per-provider map with one entry replaced; blank clears the entry. */
function withProvider(
  current: Readonly<Partial<Record<ProviderId, string>>>,
  provider: ProviderId,
  value: string,
): Partial<Record<ProviderId, string>> {
  const next = { ...current };
  if (value.trim()) next[provider] = value.trim();
  else delete next[provider];
  return next;
}
