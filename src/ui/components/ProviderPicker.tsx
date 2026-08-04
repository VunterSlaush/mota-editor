import { PROVIDERS, type ProviderId } from "../../core/entities/provider";

interface Props {
  value: ProviderId;
  disabled: boolean;
  onChange: (provider: ProviderId) => void;
}

/** UI — choose which AI agent answers in this project tab. */
export function ProviderPicker({ value, disabled, onChange }: Props) {
  return (
    <select
      className="provider-picker"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value as ProviderId)}
      aria-label="AI provider"
    >
      {PROVIDERS.map((p) => (
        <option key={p.id} value={p.id}>
          {p.displayName}
        </option>
      ))}
    </select>
  );
}
