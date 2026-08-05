import { PROVIDERS, type ProviderId } from "../../core/entities/provider";
import { OptionPicker, type PickerOption } from "./OptionPicker";

interface Props {
  value: ProviderId;
  disabled: boolean;
  onChange: (provider: ProviderId) => void;
}

const OPTIONS: readonly PickerOption<ProviderId>[] = PROVIDERS.map((provider) => ({
  id: provider.id,
  label: provider.displayName,
  description: provider.vendor,
}));

/** UI — choose which AI agent answers in this project tab. */
export function ProviderPicker({ value, disabled, onChange }: Props) {
  return (
    <OptionPicker
      ariaLabel="AI provider"
      options={OPTIONS}
      value={value}
      disabled={disabled}
      placement="bottom"
      align="end"
      onChange={onChange}
    />
  );
}
