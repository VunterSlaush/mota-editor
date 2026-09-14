import { useEffect, useState } from "react";
import {
  type CommandInfo,
  commandToken,
  filterCommands,
  replaceCommand,
} from "../../core/entities/command";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** What may be named here, already merged and ordered by the core. */
  commands: readonly CommandInfo[];
  placeholder?: string;
  ariaLabel?: string;
}

/**
 * UI — a one-line prompt input that completes slash commands as they are
 * typed, the composer's palette in the shape the settings rows need.
 *
 * A sequence step is a prompt like any other, so the commands it may name
 * are the ones the composer would offer — including the user's other
 * sequences, which is what makes nesting something you can discover
 * rather than something you have to know.
 */
export function CommandSuggest({
  value,
  onChange,
  commands,
  placeholder,
  ariaLabel,
}: Props) {
  const [dismissed, setDismissed] = useState(false);
  const [selected, setSelected] = useState(0);

  const token = dismissed ? null : commandToken(value);
  const matches = token === null ? [] : filterCommands(commands, token);
  const open = matches.length > 0;

  // The selection must land on a row that exists: the list shrinks with
  // every keystroke, and an index left past its end reads as the arrow
  // keys having stopped working.
  useEffect(() => {
    setSelected((current) => (current < matches.length ? current : 0));
  }, [matches.length]);

  const pick = (command: CommandInfo) => {
    onChange(replaceCommand(value, token ?? "", command.name));
    setSelected(0);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      e.stopPropagation(); // the modal closes on Escape; the menu goes first
      setDismissed(true);
      return;
    }
    if (!open) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setSelected((i) => (i + 1) % matches.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSelected((i) => (i - 1 + matches.length) % matches.length);
    } else if (e.key === "Enter" || e.key === "Tab") {
      const command = matches[selected];
      if (!command) return;
      e.preventDefault();
      pick(command);
    }
  };

  return (
    <div className="folder-suggest">
      <input
        className="settings-input"
        placeholder={placeholder}
        aria-label={ariaLabel}
        value={value}
        autoComplete="off"
        onChange={(e) => {
          setDismissed(false); // typing again is asking for the menu back
          onChange(e.target.value);
        }}
        onKeyDown={onKeyDown}
      />
      {open && (
        <div className="folder-suggest__menu" role="listbox" aria-label="Commands">
          {matches.map((command, index) => (
            <div
              key={command.name}
              role="option"
              aria-selected={index === selected}
              className={`folder-suggest__item command-suggest__item ${
                index === selected ? "folder-suggest__item--selected" : ""
              }`}
              onMouseDown={(e) => {
                e.preventDefault(); // pick without blurring the input first
                pick(command);
              }}
            >
              <span className="command-suggest__name">{command.name}</span>
              <span className="command-suggest__description">{command.description}</span>
              {command.source === "sequence" && (
                <span className="command-palette__badge">sequence</span>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
