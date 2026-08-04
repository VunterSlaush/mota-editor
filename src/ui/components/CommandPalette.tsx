import type { CommandInfo } from "../../core/entities/command";

interface Props {
  commands: readonly CommandInfo[];
  selectedIndex: number;
  onPick: (command: CommandInfo) => void;
}

/** UI — the slash-command list shown above the composer while typing "/". */
export function CommandPalette({ commands, selectedIndex, onPick }: Props) {
  if (commands.length === 0) return null;
  return (
    <div className="command-palette" role="listbox" aria-label="Available commands">
      {commands.map((command, index) => (
        <div
          key={command.name}
          role="option"
          aria-selected={index === selectedIndex}
          className={`command-palette__item ${
            index === selectedIndex ? "command-palette__item--selected" : ""
          }`}
          onMouseDown={(e) => {
            e.preventDefault(); // keep focus in the textarea
            onPick(command);
          }}
        >
          <span className="command-palette__name">{command.name}</span>
          <span className="command-palette__description">{command.description}</span>
          {command.source === "custom" && (
            <span className="command-palette__badge">custom</span>
          )}
        </div>
      ))}
    </div>
  );
}
