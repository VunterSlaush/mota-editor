import { useState } from "react";

/** Which way the panel grows as the pointer moves right. */
export type GrowDirection = "right" | "left";

export interface DragWidth {
  readonly width: number;
  readonly startResize: (e: React.PointerEvent) => void;
}

/**
 * UI — drag-to-resize for a side panel, clamped to a range.
 *
 * A panel anchored on the left (the changes sidebar) grows as the
 * pointer moves right; one anchored on the right (the plan viewer) grows
 * as it moves left, which is the only difference between the two.
 */
export function useDragWidth(
  initial: number,
  min: number,
  max: number,
  grow: GrowDirection = "right",
): DragWidth {
  const [width, setWidth] = useState(initial);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = width;
    const sign = grow === "right" ? 1 : -1;

    const onMove = (move: PointerEvent) => {
      const next = startWidth + sign * (move.clientX - startX);
      setWidth(Math.min(max, Math.max(min, next)));
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  return { width, startResize };
}
