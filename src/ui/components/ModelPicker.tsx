import { useEffect, useState } from "react";
import { MODEL_SUGGESTIONS, type ProviderId } from "../../core/entities/provider";

interface Props {
  provider: ProviderId;
  value: string;
  disabled: boolean;
  onChange: (model: string) => void;
}

/**
 * UI — model override for the tab's agent: a combo box (free text +
 * per-provider suggestions). Empty means the provider's default model.
 * Committed on blur or Enter, not per keystroke.
 */
export function ModelPicker({ provider, value, disabled, onChange }: Props) {
  const [draft, setDraft] = useState(value);

  useEffect(() => setDraft(value), [value, provider]);

  const commit = () => {
    if (draft.trim() !== value) onChange(draft);
  };

  const listId = `models-${provider}`;
  return (
    <>
      <input
        className="model-picker"
        list={listId}
        value={draft}
        placeholder="model: default"
        disabled={disabled}
        aria-label="Model"
        title="Model for this tab's agent — pick a suggestion or type any model id. Empty = provider default. Applies on the next message."
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
      />
      <datalist id={listId}>
        {MODEL_SUGGESTIONS[provider].map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>
    </>
  );
}
