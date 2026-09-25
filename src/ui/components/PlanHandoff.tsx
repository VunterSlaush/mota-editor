import { Gauge } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { PermissionPolicy } from "../../core/entities/agentSettings";
import {
  type ModelCatalog,
  reasoningChoices,
  supportedEffort,
} from "../../core/entities/modelCatalog";
import type { ProviderId } from "../../core/entities/provider";
import type { FreshSessionSpec } from "../../core/usecases/executePlanInFreshSession";
import { ModelPicker } from "./ModelPicker";
import { OptionPicker, type PickerOption } from "./OptionPicker";
import { PermissionPicker } from "./PermissionPicker";
import { ProviderPicker } from "./ProviderPicker";

interface Props {
  /** The tab's current settings — where each picker starts. */
  provider: ProviderId;
  permission: PermissionPolicy;
  /** Whether Jev's gate runs — the only time "Auto with Jev" is offered. */
  jevGate: boolean;
  modelCatalogs?: Partial<Record<ProviderId, ModelCatalog>>;
  modelProblems?: Partial<Record<ProviderId, string>>;
  /** Probes a provider's models. Codex has none until it is asked, and
   *  the tab may never have used the provider being picked here. */
  discoverModels: (provider: ProviderId) => Promise<void>;
  onConfirm: (spec: FreshSessionSpec) => void;
}

/**
 * UI — the plan card's handoff panel: which agent should carry out the
 * plan, and under what permissions.
 *
 * Every picker starts on what the tab is already set to, so confirming
 * without touching anything is a plain "start over on this plan" rather
 * than a silent change of vendor.
 */
export function PlanHandoff({
  provider: tabProvider,
  permission: tabPermission,
  jevGate,
  modelCatalogs,
  modelProblems,
  discoverModels,
  onConfirm,
}: Props) {
  const [provider, setProvider] = useState<ProviderId>(tabProvider);
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [permission, setPermission] = useState<PermissionPolicy>(tabPermission);

  const catalog = modelCatalogs?.[provider];

  // The model list for a provider this tab never ran does not exist yet.
  // Idempotent and memoized per app run, so switching back and forth
  // costs nothing.
  useEffect(() => {
    void discoverModels(provider);
  }, [provider, discoverModels]);

  // A model id means nothing to another vendor, and neither does its
  // effort level.
  const changeProvider = (next: ProviderId) => {
    setProvider(next);
    setModel("");
    setEffort("");
  };

  const changeModel = (next: string) => {
    setModel(next);
    setEffort(supportedEffort(catalog, next, effort));
  };

  const effortLevels = reasoningChoices(provider, catalog, model);
  const effortOptions: readonly PickerOption<string>[] = [
    { id: "", label: "Default effort", icon: <Gauge /> },
    ...effortLevels.map((level) => ({ id: level, label: level, icon: <Gauge /> })),
  ];

  return (
    <div className="approval__handoff-panel">
      <div className="approval__handoff-pickers">
        <ProviderPicker value={provider} disabled={false} onChange={changeProvider} />
        <ModelPicker
          catalog={catalog}
          problem={modelProblems?.[provider]}
          provider={provider}
          value={model}
          disabled={false}
          placement="bottom"
          align="start"
          onChange={changeModel}
        />
        {effortLevels.length > 0 && (
          <OptionPicker
            ariaLabel="Reasoning effort"
            options={effortOptions}
            value={effort}
            disabled={false}
            placeholder="effort"
            placement="bottom"
            className="picker__trigger--dim"
            onChange={setEffort}
          />
        )}
        <PermissionPicker
          value={permission}
          disabled={false}
          jevGate={jevGate}
          placement="bottom"
          onChange={setPermission}
        />
      </div>
      <div className="approval__handoff-note">
        This plan is turned down here and sent to the new agent as the first message of a
        fresh chat. This conversation is cleared — the plan itself is all that carries
        over.
      </div>
      <button
        type="button"
        className="approval__button approval__handoff-confirm"
        onClick={() => onConfirm({ provider, model, effort, permission })}
      >
        <span className="approval__button-label">Start the fresh session</span>
      </button>
    </div>
  );
}
