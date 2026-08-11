import { Cpu } from "@phosphor-icons/react";
import { MODEL_SUGGESTIONS, type ProviderId } from "../../core/entities/provider";
import { OptionPicker, type PickerOption } from "./OptionPicker";

interface Props {
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
  defaultModel,
  pendingValue,
  disabled,
  onChange,
  placement = "top",
  align = "end",
  className = "picker__trigger--dim",
}: Props) {
  const shown = pendingValue ?? value;
  const suggestions = MODEL_SUGGESTIONS[provider];
  const custom = shown !== "" && !suggestions.includes(shown) ? [shown] : [];
  const label = (model: string) => {
    const base =
      model === ""
        ? defaultModel
          ? `Default: ${defaultModel}`
          : "Default model"
        : model;
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
  );
}
