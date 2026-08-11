import { CircleNotch } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { GitBranch } from "../../core/ports/gitPort";
import type { GitActionResult } from "../../core/usecases/gitActions";

interface Props {
  branches: readonly GitBranch[];
  /** Resolves once the checkout AND the git refresh behind it are done,
   *  so the picker is the thing that waits — not the app underneath. */
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
 *
 * A checkout that WORKS takes time: git rewrites the working tree, and
 * the app re-reads it. The picker stays up and says so for all of it —
 * a modal that vanishes onto a screen still showing the old branch is
 * what made switching feel like nothing had happened.
 */
export function BranchPicker({ branches, onPick, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [checkingOut, setCheckingOut] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // On open, and again when a refused checkout hands the picker back:
  // the search box is disabled mid-checkout, which drops focus with it.
  useEffect(() => {
    if (!checkingOut) inputRef.current?.focus();
  }, [checkingOut]);

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
        className={`branch-picker ${checkingOut ? "branch-picker--busy" : ""}`}
        role="dialog"
        aria-label="Checkout branch"
        aria-busy={checkingOut !== null}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="branch-picker__search"
          placeholder="Search branches…"
          value={query}
          disabled={checkingOut !== null}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        {checkingOut && (
          <p className="branch-picker__status" role="status">
            <CircleNotch
              size={12}
              className="branch-picker__spinner"
              aria-hidden="true"
            />
            Switching to {checkingOut}…
          </p>
        )}
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
              {branch.current && <span className="branch-picker__current">current</span>}
              {branch.remote && <span className="branch-picker__remote">remote</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
