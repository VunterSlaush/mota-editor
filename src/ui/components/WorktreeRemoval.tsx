import type { RemovalCheck } from "../../core/entities/worktree";

interface Props {
  check: RemovalCheck;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * UI — the second half of the two-step removal: what it would cost, and
 * the button that does it. Shared by the picker and the worktrees panel,
 * so a worktree is deleted through the same words wherever it is deleted
 * from.
 *
 * A worktree holding uncommitted work says so in the button itself —
 * "Delete anyway" is harder to click by reflex than a bare "Remove",
 * which is the point.
 */
export function RemovalConfirm({ check, busy, onCancel, onConfirm }: Props) {
  return (
    <div className="worktree-picker__confirm">
      <span className="worktree-picker__confirm-text">
        {check.blockers.length > 0
          ? check.blockers.join(" ")
          : "Deletes the folder. The branch and its commits stay."}
      </span>
      <button type="button" className="worktree-picker__confirm-no" onClick={onCancel}>
        Cancel
      </button>
      {/* Nothing to offer when no mode of removal would work: git would
          refuse a forced one too. */}
      {!check.blocked && (
        <button
          type="button"
          className="worktree-picker__confirm-yes"
          disabled={busy}
          onClick={onConfirm}
        >
          {check.needsForce ? "Delete anyway" : "Remove"}
        </button>
      )}
    </div>
  );
}
