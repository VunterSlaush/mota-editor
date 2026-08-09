import { useEffect, useRef, useState } from "react";

/** Below this many pixels a pointer gesture is still a click, not a drag. */
const DRAG_THRESHOLD_PX = 4;

export interface DragReorder {
  /** The item being dragged, for styling. Null when idle. */
  readonly draggingId: string | null;
  readonly startDrag: (id: string, e: React.PointerEvent) => void;
  /** True while the pointer that just went up had really been dragged, so
   *  the click that follows a drop can be ignored. */
  readonly wasDragged: () => boolean;
}

/**
 * UI — drag an item to another position in a horizontal row.
 *
 * The row's own children are the measuring stick: the target index is the
 * one whose element the pointer's midpoint has crossed. `onMove` fires
 * during the drag, so the row shuffles under the cursor rather than
 * jumping once on drop.
 */
export function useDragReorder(
  onMove: (id: string, toIndex: number) => void,
  itemSelector: string,
): DragReorder {
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const draggedRef = useRef(false);
  // Unmounting mid-drag (the last tab closed) must not leave listeners behind.
  const stopDragRef = useRef<(() => void) | null>(null);
  useEffect(() => () => stopDragRef.current?.(), []);

  const startDrag = (id: string, e: React.PointerEvent) => {
    if (e.button !== 0) return; // a right-click is a menu, not a drag
    // A button inside the item (a tab's close ×) is its own affordance.
    if ((e.target as HTMLElement).closest("button")) return;
    const row = e.currentTarget.parentElement;
    if (!row) return;
    const startX = e.clientX;
    draggedRef.current = false;
    // Every move event would otherwise re-announce the position the item
    // is already in, and each announcement costs a save.
    let announced = -1;

    const onPointerMove = (move: PointerEvent) => {
      if (!draggedRef.current) {
        if (Math.abs(move.clientX - startX) < DRAG_THRESHOLD_PX) return;
        draggedRef.current = true;
        setDraggingId(id);
      }
      const items = Array.from(row.querySelectorAll(itemSelector));
      const crossed = items.findIndex((item) => {
        const box = item.getBoundingClientRect();
        return move.clientX < box.left + box.width / 2;
      });
      const target = crossed === -1 ? items.length - 1 : crossed;
      if (target === announced) return;
      announced = target;
      onMove(id, target);
    };
    const stopDrag = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDrag);
      stopDragRef.current = null;
      setDraggingId(null);
    };

    stopDragRef.current?.();
    stopDragRef.current = stopDrag;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
  };

  return { draggingId, startDrag, wasDragged: () => draggedRef.current };
}
