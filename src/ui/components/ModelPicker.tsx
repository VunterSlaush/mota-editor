import { Cpu } from "@phosphor-icons/react";
import { type ModelCatalog, modelChoices } from "../../core/entities/modelCatalog";
import type { ProviderId } from "../../core/entities/provider";
import { OptionPicker, type PickerOption } from "./OptionPicker";

interface Props {
  catalog?: ModelCatalog;
  problem?: string;
  provider: ProviderId;
  value: string;
  /** What "default" resolves to (the app's per-provider default model),
   *  so the option can say it. Empty/omitted = the provider's own. */
  defaultModel?: string;
  /** A model chosen mid-conversation and held back until the next chat.
   *  Shown in place of `value` — the user picked it and must see it —
   *  but labelled, so it never passes for what the agent is running. */
  pendingValue?: string;
  disabled: boolean;
  onChange: (model: string) => void;
  /** Passed through to the picker. The defaults suit the composer
   *  toolbar, which sits at the bottom-right of the window. */
  placement?: "top" | "bottom";
  align?: "start" | "end";
  className?: string;
}

/** Model overrides from discovery, retaining saved choices across catalog changes. */
export function ModelPicker({
  catalog,
  problem,
  provider,
  value,
  defaultModel,
  pendingValue,
  disabled,
  onChange,
  placement = "top",
  align = "end",
  className = "picker__trigger--dim",
}: Props) {
  const shown = pendingValue ?? value;
  const suggestions = modelChoices(provider, catalog, shown);
  const label = (model: string) => {
    const base =
      model === ""
        ? defaultModel || catalog?.defaultModel
          ? `Default: ${defaultModel || catalog?.defaultModel}`
          : "Default model"
        : model;
    return model === pendingValue ? `${base} · next chat` : base;
  };
  const options: readonly PickerOption<string>[] = [
    { id: "", label: label(""), icon: <Cpu /> },
    ...suggestions.map((model) => ({ id: model, label: label(model), icon: <Cpu /> })),
  ];

  return (
    <div
      title={
        problem ||
        (provider === "codex" && !catalog ? "Loading Codex models…" : undefined)
      }
    >
      <OptionPicker
        ariaLabel="Model"
        options={options}
        value={shown}
        disabled={disabled}
        placement={placement}
        align={align}
        // The pending marker is added to whatever the caller asked for,
        // never instead of it: a deferred value must read as unsettled
        // wherever the picker is used.
        className={
          pendingValue !== undefined ? `${className} picker__trigger--pending` : className
        }
        onChange={onChange}
      />
      {problem && (
        <span className="tool-row__warning" role="status">
          {problem}
        </span>
      )}
    </div>
  );
}
