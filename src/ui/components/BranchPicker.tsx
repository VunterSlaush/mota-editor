import { useEffect, useRef, useState } from "react";
import type { GitBranch } from "../../core/ports/gitPort";

interface Props {
  branches: readonly GitBranch[];
  onPick: (branch: string) => void;
  onClose: () => void;
}

/**
 * UI — VS-style branch picker: a small modal with a search bar; type to
 * filter, Enter/click to checkout, Escape or click-outside to close.
 */
export function BranchPicker({ branches, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const filtered = branches.filter((b) =>
    b.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const pick = (branch: GitBranch) => {
    if (!branch.current) onPick(branch.name);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex(
        (selectedIndex + delta + filtered.length) % Math.max(filtered.length, 1),
      );
    } else if (e.key === "Enter" && filtered.length > 0) {
      e.preventDefault();
      pick(filtered[Math.min(selectedIndex, filtered.length - 1)]);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="branch-picker"
        role="dialog"
        aria-label="Checkout branch"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="branch-picker__search"
          placeholder="Search branches…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="branch-picker__list" role="listbox">
          {filtered.length === 0 && (
            <div className="branch-picker__empty">No branches match "{query}"</div>
          )}
          {filtered.map((branch, index) => (
            <div
              key={branch.name}
              role="option"
              aria-selected={index === selectedIndex}
              className={`branch-picker__item ${
                index === selectedIndex ? "branch-picker__item--selected" : ""
              }`}
              onMouseEnter={() => setSelectedIndex(index)}
              onClick={() => pick(branch)}
            >
              <span className="branch-picker__name"> {branch.name}</span>
              {branch.current && <span className="branch-picker__current">current</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
