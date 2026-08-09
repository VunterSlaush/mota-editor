import { Cpu } from "@phosphor-icons/react";
import { MODEL_SUGGESTIONS, type ProviderId } from "../../core/entities/provider";
import { OptionPicker, type PickerOption } from "./OptionPicker";

interface Props {
  provider: ProviderId;
  value: string;
  /** A model chosen mid-conversation and held back until the next chat.
   *  Shown in place of `value` — the user picked it and must see it —
   *  but labelled, so it never passes for what the agent is running. */
  pendingValue?: string;
  disabled: boolean;
  onChange: (model: string) => void;
}

/**
 * UI — model override for the tab's agent. A picker, not a text box: the
 * choice is a short closed list, and a search field for five options
 * invites typing where only picking makes sense. Empty means the
 * provider's default model. A model set elsewhere (settings, a restored
 * workspace) that isn't a suggestion is kept as its own option, so
 * opening the list can never silently drop it.
 */
export function ModelPicker({
  provider,
  value,
  pendingValue,
  disabled,
  onChange,
}: Props) {
  const shown = pendingValue ?? value;
  const suggestions = MODEL_SUGGESTIONS[provider];
  const custom = shown !== "" && !suggestions.includes(shown) ? [shown] : [];
  const label = (model: string) => {
    const base = model === "" ? "Default model" : model;
    return model === pendingValue ? `${base} · next chat` : base;
  };
  const options: readonly PickerOption<string>[] = [
    { id: "", label: label(""), icon: <Cpu /> },
    ...custom.map((model) => ({ id: model, label: label(model), icon: <Cpu /> })),
    ...suggestions.map((model) => ({ id: model, label: label(model), icon: <Cpu /> })),
  ];

  return (
    <OptionPicker
      ariaLabel="Model"
      options={options}
      value={shown}
      disabled={disabled}
      align="end"
      className={
        pendingValue !== undefined
          ? "picker__trigger--dim picker__trigger--pending"
          : "picker__trigger--dim"
      }
      onChange={onChange}
    />
  );
}
