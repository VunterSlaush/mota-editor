import { useRef, useState } from "react";

/** A size the user dragged a modal to. */
export interface ModalSize {
  readonly width: number;
  readonly height: number;
}

/**
 * How the overlay places the modal, which decides what a dragged pixel is
 * worth. A centred modal splits every pixel of width AND height between
 * opposite edges; one anchored to the top splits only its width. Getting
 * this wrong makes the grabbed corner drift away from the cursor.
 */
export type ModalAnchor = "top" | "center";

/**
 * UI — the bottom-right grip that resizes a modal, shared by every modal
 * that has one so the drag arithmetic is stated once.
 *
 * `size` is null until the user drags, which leaves the modal on its CSS
 * default layout — the caps there handle the top end, `minimum` the bottom.
 */
export function useResizableModal(minimum: ModalSize, anchor: ModalAnchor) {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<ModalSize | null>(null);

  const startResize = (e: React.PointerEvent) => {
    e.preventDefault();
    const modal = ref.current;
    if (!modal) return;
    const startX = e.clientX;
    const startY = e.clientY;
    const { width, height } = modal.getBoundingClientRect();
    const verticalTravel = anchor === "center" ? 2 : 1;

    const onMove = (move: PointerEvent) => {
      setSize({
        width: Math.max(minimum.width, width + (move.clientX - startX) * 2),
        height: Math.max(
          minimum.height,
          height + (move.clientY - startY) * verticalTravel,
        ),
      });
    };
    const stopDrag = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", stopDrag);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", stopDrag);
  };

  return { ref, size, startResize, resetSize: () => setSize(null) };
}
