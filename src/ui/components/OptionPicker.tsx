import type { OptionDescriptor } from "../../core/entities/agentSettings";

interface Props<T extends string> {
  ariaLabel: string;
  options: readonly OptionDescriptor<T>[];
  value: T;
  disabled: boolean;
  onChange: (value: T) => void;
}

/** UI — generic dropdown for a described option set (mode, permission). */
export function OptionPicker<T extends string>({
  ariaLabel,
  options,
  value,
  disabled,
  onChange,
}: Props<T>) {
  const current = options.find((o) => o.id === value);
  return (
    <select
      className="option-picker"
      value={value}
      disabled={disabled}
      title={current?.description}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value as T)}
    >
      {options.map((o) => (
        <option key={o.id} value={o.id} title={o.description}>
          {o.label}
        </option>
      ))}
    </select>
  );
}
