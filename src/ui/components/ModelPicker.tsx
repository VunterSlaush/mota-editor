import { Cpu } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
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
 *
 * The exception is a provider that publishes no list at all, because its
 * catalogue lives behind the user's own account (Cline). There is no
 * closed list to pick from, so the control becomes what it honestly is —
 * a text field. Blank still means the provider's default.
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
  if (suggestions.length === 0) {
    return (
      <ModelField
        value={shown}
        defaultModel={defaultModel}
        pending={pendingValue !== undefined}
        disabled={disabled}
        className={className}
        onChange={onChange}
      />
    );
  }
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

/**
 * The text-field form, for providers whose model list is not ours to
 * know. Edits are local until the user commits with Enter or by leaving
 * the field: reporting every keystroke would respawn the agent letter by
 * letter, since a model change is what makes a session's shape stale.
 */
function ModelField({
  value,
  defaultModel,
  pending,
  disabled,
  className,
  onChange,
}: {
  value: string;
  defaultModel?: string;
  pending: boolean;
  disabled: boolean;
  className: string;
  onChange: (model: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  // A model set elsewhere — settings, a restored workspace, a preset —
  // has to win over a stale draft, or the field would show one model
  // while the agent ran another.
  useEffect(() => setDraft(value), [value]);

  const commit = () => {
    const next = draft.trim();
    setDraft(next);
    if (next !== value) onChange(next);
  };

  return (
    <input
      type="text"
      className={`picker__trigger model-field ${className} ${
        pending ? "picker__trigger--pending" : ""
      }`}
      aria-label="Model"
      value={draft}
      disabled={disabled}
      spellCheck={false}
      placeholder={defaultModel ? `Default: ${defaultModel}` : "Default model"}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        } else if (e.key === "Escape") {
          setDraft(value);
          e.currentTarget.blur();
        }
      }}
    />
  );
}
