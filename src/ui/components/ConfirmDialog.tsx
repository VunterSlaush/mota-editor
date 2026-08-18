import { useEffect, useRef } from "react";

interface Props {
  title: string;
  /** What the confirm button would cost, in plain words. */
  message: string;
  /**
   * What is at stake, named one line at a time. Each line carries its
   * own id: two tabs can wear the same label, and the list must still
   * show both. A line with `onSelect` becomes a button — used where a
   * named file has a diff worth reading before agreeing to lose it.
   */
  detail?: readonly {
    readonly id: string;
    readonly label: string;
    readonly onSelect?: () => void;
  }[];
  /** The wording on the button that goes ahead. */
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => void;
}

/**
 * UI — the app's one "are you sure?".
 *
 * Cancel is what the dialog defaults to and what Escape, the overlay and
 * the initial focus all reach: this only ever appears in front of an
 * action that destroys something, so the safe answer is the easy one.
 */
export function ConfirmDialog({
  title,
  message,
  detail,
  confirmLabel,
  onCancel,
  onConfirm,
}: Props) {
  const cancelButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    cancelButton.current?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onCancel();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onCancel]);

  return (
    <div className="modal-overlay modal-overlay--center" onMouseDown={onCancel}>
      <div
        className="confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="confirm-dialog__title">{title}</h2>
        <p className="confirm-dialog__message">{message}</p>
        {detail && detail.length > 0 && (
          <ul className="confirm-dialog__detail">
            {detail.map((line) => (
              <li key={line.id}>
                {line.onSelect ? (
                  <button
                    type="button"
                    className="confirm-dialog__detail-link"
                    onClick={line.onSelect}
                  >
                    {line.label}
                  </button>
                ) : (
                  line.label
                )}
              </li>
            ))}
          </ul>
        )}
        <div className="confirm-dialog__actions">
          <button
            ref={cancelButton}
            type="button"
            className="confirm-dialog__cancel"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button type="button" className="confirm-dialog__confirm" onClick={onConfirm}>
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
