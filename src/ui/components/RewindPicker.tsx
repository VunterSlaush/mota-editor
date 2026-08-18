import { CircleNotch } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import {
  describeStat,
  isUnchanged,
  type RewindPoint,
} from "../../core/entities/checkpoint";
import type { CheckpointPreview } from "../../core/ports/checkpointPort";

interface Props {
  points: readonly RewindPoint[];
  /** What rewinding to this point would change; null when the snapshot
   *  is no longer available. */
  onPreview: (checkpoint: string) => Promise<CheckpointPreview | null>;
  onPick: (point: RewindPoint, preview: CheckpointPreview) => void;
  onClose: () => void;
}

/** Prompts are whole messages; the row shows the first line of one. */
const PROMPT_CHARS = 90;

/**
 * UI — pick a turn to put the files back to.
 *
 * The list is the conversation's own prompts, newest first, because
 * "before I asked for that" is how anyone actually remembers where they
 * want to land. Each row's cost is fetched when it is highlighted rather
 * than up front: a preview is a `git diff` per row, and a long chat
 * would run dozens of them to fill a list the user reads three of.
 */
export function RewindPicker({ points, onPreview, onPick, onClose }: Props) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previews, setPreviews] = useState<Record<string, CheckpointPreview | null>>({});
  const [loading, setLoading] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  const selected = points[selectedIndex];
  const checkpoint = selected?.checkpoint;

  // Fetch the highlighted row's cost, once. `previews` is keyed by
  // checkpoint so walking back up the list is instant.
  useEffect(() => {
    if (!checkpoint || checkpoint in previews) return;
    let cancelled = false;
    setLoading(checkpoint);
    void onPreview(checkpoint).then((preview) => {
      if (cancelled) return;
      setLoading(null);
      setPreviews((all) => ({ ...all, [checkpoint]: preview }));
    });
    return () => {
      cancelled = true;
    };
    // The loader is a fresh closure per render; the checkpoint is the work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checkpoint]);

  useEffect(() => {
    listRef.current
      ?.querySelector(".rewind-picker__item--selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  const pick = (index: number) => {
    const point = points[index];
    const preview = point && previews[point.checkpoint];
    // Nothing to restore is not a rewind — the row says so and stays put
    // rather than closing on an action that would do nothing.
    if (!point || !preview || isUnchanged(preview.stat)) return;
    onPick(point, preview);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex(
        (selectedIndex + delta + points.length) % Math.max(points.length, 1),
      );
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(selectedIndex);
    }
  };

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="rewind-picker"
        role="dialog"
        aria-label="Rewind files"
        tabIndex={-1}
        onKeyDown={onKeyDown}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="rewind-picker__header">
          <h2 className="rewind-picker__title">Rewind files</h2>
          <p className="rewind-picker__subtitle">
            Put the project back the way it was before a message. The conversation is left
            as it is.
          </p>
        </header>
        <div className="rewind-picker__list" role="listbox" ref={listRef}>
          {points.length === 0 && (
            <div className="rewind-picker__empty">
              No snapshots in this chat yet. A turn gets one when the project is a git
              repository.
            </div>
          )}
          {points.map((point, index) => {
            const preview = previews[point.checkpoint];
            return (
              <div
                key={point.messageId}
                role="option"
                aria-selected={index === selectedIndex}
                className={`rewind-picker__item ${
                  index === selectedIndex ? "rewind-picker__item--selected" : ""
                }`}
                onMouseEnter={() => setSelectedIndex(index)}
                onClick={() => pick(index)}
              >
                <span className="rewind-picker__prompt">{excerpt(point.prompt)}</span>
                <span className="rewind-picker__when">{clockTime(point.sentAt)}</span>
                <span className="rewind-picker__stat">
                  {loading === point.checkpoint ? (
                    <CircleNotch
                      size={12}
                      className="rewind-picker__spinner"
                      aria-hidden="true"
                    />
                  ) : preview === null ? (
                    "unavailable"
                  ) : preview ? (
                    isUnchanged(preview.stat) ? (
                      "no changes"
                    ) : (
                      describeStat(preview.stat)
                    )
                  ) : (
                    ""
                  )}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function excerpt(prompt: string): string {
  const line = prompt.trim().split("\n")[0] ?? "";
  return line.length > PROMPT_CHARS ? `${line.slice(0, PROMPT_CHARS)}…` : line;
}

function clockTime(at: number): string {
  return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
