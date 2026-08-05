import { X } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import {
  countChanges,
  type DiffLine,
  parseUnifiedDiff,
  toSideBySide,
} from "../../core/entities/diff";
import { fileName } from "../fileName";

interface Props {
  path: string;
  /** True when showing the index side rather than the working tree. */
  staged: boolean;
  /** Resolves with the unified diff, or rejects with git's message. */
  load: () => Promise<{ ok: boolean; message: string }>;
  onClose: () => void;
}

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; text: string };

/**
 * UI — one file's change, old on the left and new on the right, in the
 * red/green everyone already reads. Escape or a click outside closes it.
 */
/** A resized modal never goes below this; the CSS caps handle the top end. */
const MIN_WIDTH_PX = 480;
const MIN_HEIGHT_PX = 240;

export function DiffModal({ path, staged, load, onClose }: Props) {
  const [result, setResult] = useState<Load>({ state: "loading" });
  // A size the user dragged the modal to; null means the default layout.
  const [size, setSize] = useState<{ width: number; height: number } | null>(null);
  const modalRef = useRef<HTMLDivElement>(null);

  // Drag the bottom-right grip. The modal is horizontally centred, so
  // each pixel of width is split between both edges — the ×2 keeps the
  // grabbed corner under the cursor. Double-click returns to the default.
  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const el = modalRef.current;
    if (!el) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const { width, height } = el.getBoundingClientRect();

    const onMove = (move: PointerEvent) => {
      setSize({
        width: Math.max(MIN_WIDTH_PX, width + (move.clientX - startX) * 2),
        height: Math.max(MIN_HEIGHT_PX, height + (move.clientY - startY)),
      });
    };
    const stopDrag = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stopDrag);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stopDrag);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    load().then((r) => {
      if (cancelled) return;
      setResult(
        r.ok
          ? { state: "loaded", text: r.message }
          : { state: "failed", message: r.message },
      );
    });
    return () => {
      cancelled = true;
    };
    // The loader is a fresh closure per render; the file identifies the work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, staged]);

  const hunks = result.state === "loaded" ? parseUnifiedDiff(result.text) : [];
  const { added, removed } = countChanges(hunks);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        ref={modalRef}
        className="diff-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Diff for ${path}`}
        style={size ?? undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="diff-modal__header">
          <span className="diff-modal__name">{fileName(path)}</span>
          <span className="diff-modal__path">{path}</span>
          <span className="diff-modal__badge">{staged ? "staged" : "not staged"}</span>
          {result.state === "loaded" && hunks.length > 0 && (
            <span className="diff-modal__stat">
              <span className="diff-modal__stat--add">+{added}</span>
              <span className="diff-modal__stat--remove">−{removed}</span>
            </span>
          )}
          <button
            type="button"
            className="diff-modal__close"
            aria-label="Close diff"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="diff-modal__body">
          {result.state === "loading" && (
            <p className="diff-modal__note">Loading diff…</p>
          )}
          {result.state === "failed" && (
            <p className="diff-modal__note diff-modal__note--error">{result.message}</p>
          )}
          {result.state === "loaded" && hunks.length === 0 && (
            <p className="diff-modal__note">
              No textual changes — the file may be binary, or only its mode changed.
            </p>
          )}
          {hunks.map((hunk, hunkIndex) => (
            <section
              // biome-ignore lint/suspicious/noArrayIndexKey: two hunks can share a header; order is the identity
              key={hunkIndex}
              className="diff-hunk"
            >
              <div className="diff-hunk__header">{hunk.header}</div>
              {toSideBySide(hunk).map((row, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are a positional pairing within one hunk
                  key={index}
                  className="diff-row"
                >
                  <Side line={row.left} side="old" />
                  <Side line={row.right} side="new" />
                </div>
              ))}
            </section>
          ))}
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only affordance; the modal is fully usable at its default size */}
        <div
          className="diff-modal__resize"
          title="Drag to resize · double-click to reset"
          onPointerDown={startResize}
          onDoubleClick={() => setSize(null)}
        />
      </div>
    </div>
  );
}

/** One column of a row. An absent line is the blank half of a change. */
function Side({ line, side }: { line?: DiffLine; side: "old" | "new" }) {
  if (!line) return <div className="diff-cell diff-cell--empty" />;
  // The old column shows removals, the new one additions; context shows
  // on both. Anything else would be the same line coloured twice.
  const kind = line.kind === "context" ? "context" : side === "old" ? "remove" : "add";
  const number = side === "old" ? line.oldNo : line.newNo;
  return (
    <div className={`diff-cell diff-cell--${kind}`}>
      <span className="diff-cell__no">{number ?? ""}</span>
      <span className="diff-cell__sign">
        {kind === "add" ? "+" : kind === "remove" ? "−" : " "}
      </span>
      <span className="diff-cell__text">{line.text}</span>
    </div>
  );
}
