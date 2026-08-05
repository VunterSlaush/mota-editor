import { Cpu } from "@phosphor-icons/react";
import { MODEL_SUGGESTIONS, type ProviderId } from "../../core/entities/provider";
import { OptionPicker, type PickerOption } from "./OptionPicker";

interface Props {
  provider: ProviderId;
  value: string;
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
export function ModelPicker({ provider, value, disabled, onChange }: Props) {
  const suggestions = MODEL_SUGGESTIONS[provider];
  const custom = value !== "" && !suggestions.includes(value) ? [value] : [];
  const options: readonly PickerOption<string>[] = [
    { id: "", label: "Default model", icon: <Cpu /> },
    ...custom.map((model) => ({ id: model, label: model, icon: <Cpu /> })),
    ...suggestions.map((model) => ({ id: model, label: model, icon: <Cpu /> })),
  ];

  return (
    <OptionPicker
      ariaLabel="Model"
      options={options}
      value={value}
      disabled={disabled}
      align="end"
      className="picker__trigger--dim"
      onChange={onChange}
    />
  );
}
