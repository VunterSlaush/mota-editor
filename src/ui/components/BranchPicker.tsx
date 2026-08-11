import { useEffect, useRef, useState } from "react";
import type { GitBranch } from "../../core/ports/gitPort";
import type { GitActionResult } from "../../core/usecases/gitActions";

interface Props {
  branches: readonly GitBranch[];
  onPick: (branch: string) => Promise<GitActionResult>;
  onClose: () => void;
}

/**
 * UI — VS-style branch picker: a small modal with a search bar; type to
 * filter, Enter/click to checkout, Escape or click-outside to close.
 *
 * A checkout git refuses — uncommitted changes are the everyday case —
 * keeps the modal open with git's own reason on it, because closing on
 * failure left the user on the old branch with nothing said.
 */
export function BranchPicker({ branches, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  const filtered = branches.filter((b) =>
    b.name.toLowerCase().includes(query.trim().toLowerCase()),
  );

  const pick = async (branch: GitBranch) => {
    if (checkingOut) return;
    if (branch.current) {
      onClose();
      return;
    }
    setCheckingOut(branch.name);
    setError(null);
    const result = await onPick(branch.name);
    setCheckingOut(null);
    if (result.ok) onClose();
    else setError(result.message || `Could not check out ${branch.name}.`);
  };

  // Dismissing mid-checkout would throw away the outcome, error included.
  const close = () => {
    if (!checkingOut) onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      close();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex(
        (selectedIndex + delta + filtered.length) % Math.max(filtered.length, 1),
      );
    } else if (e.key === "Enter" && filtered.length > 0) {
      e.preventDefault();
      void pick(filtered[Math.min(selectedIndex, filtered.length - 1)]);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={close}>
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
        {error && (
          <p className="branch-picker__error" role="alert">
            {error}
          </p>
        )}
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
              onClick={() => void pick(branch)}
            >
              <span className="branch-picker__name"> {branch.name}</span>
              {checkingOut === branch.name && (
                <span className="branch-picker__current">checking out…</span>
              )}
              {branch.current && <span className="branch-picker__current">current</span>}
              {branch.remote && <span className="branch-picker__remote">remote</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
