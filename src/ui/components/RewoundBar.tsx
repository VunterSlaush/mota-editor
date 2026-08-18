import { ArrowCounterClockwise, X } from "@phosphor-icons/react";

interface Props {
  /** What the rewind changed, e.g. "7 files · +12 -4". */
  summary: string;
  onUndo: () => void;
  onDismiss: () => void;
}

/**
 * UI — what the last rewind did, with the way back.
 *
 * It sits above the composer rather than in the transcript because it is
 * an offer, not a record: the transcript already has the notice. Undo is
 * the whole reason it exists — rewinding one turn too far is the mistake
 * this feature invites, and it should cost one click to fix.
 */
export function RewoundBar({ summary, onUndo, onDismiss }: Props) {
  return (
    <div className="rewound-bar" role="status">
      <ArrowCounterClockwise size={14} aria-hidden="true" />
      <span className="rewound-bar__text">Files rewound · {summary}</span>
      <button type="button" className="rewound-bar__undo" onClick={onUndo}>
        Undo rewind
      </button>
      <button
        type="button"
        className="rewound-bar__dismiss"
        aria-label="Dismiss"
        onClick={onDismiss}
      >
        <X size={12} />
      </button>
    </div>
  );
}
