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
 * The dragged element follows the pointer via a transform while the row's
 * own children are the measuring stick: the target index is the one whose
 * element the pointer's midpoint has crossed. `onMove` fires during the
 * drag, so the row shuffles under the cursor rather than jumping once on
 * drop, and displaced neighbours slide to their new slot.
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
    const el = e.currentTarget as HTMLElement;
    const row = el.parentElement;
    if (!row) return;
    const startX = e.clientX;
    // Where inside the item the pointer grabbed it, so the item rides the
    // pointer at that spot instead of snapping its edge to the cursor.
    const grabOffset = startX - el.getBoundingClientRect().left;
    draggedRef.current = false;
    let lastX = startX;
    let translate = 0;
    // Every move event would otherwise re-announce the position the item
    // is already in, and each announcement costs a save.
    let announced = -1;

    // Transforms shift what getBoundingClientRect reports, so the item's
    // resting position is its box minus whatever translate is applied.
    const followPointer = () => {
      const restingLeft = el.getBoundingClientRect().left - translate;
      translate = lastX - grabOffset - restingLeft;
      el.style.transform = `translateX(${translate}px)`;
    };

    const onPointerMove = (move: PointerEvent) => {
      if (!draggedRef.current) {
        if (Math.abs(move.clientX - startX) < DRAG_THRESHOLD_PX) return;
        draggedRef.current = true;
        setDraggingId(id);
      }
      lastX = move.clientX;
      followPointer();
      const items = Array.from(row.querySelectorAll<HTMLElement>(itemSelector));
      const crossed = items.findIndex((item) => {
        const box = item.getBoundingClientRect();
        // The dragged item's box rides the pointer; measure its resting spot.
        const left = item === el ? box.left - translate : box.left;
        return move.clientX < left + box.width / 2;
      });
      const target = crossed === -1 ? items.length - 1 : crossed;
      if (target === announced) return;
      announced = target;
      const before = new Map(
        items.map((item) => [item, item.getBoundingClientRect().left]),
      );
      onMove(id, target);
      // After React reorders the row, slide each displaced neighbour from
      // where it was to where it now sits, and re-anchor the dragged item
      // to the pointer from its new slot.
      requestAnimationFrame(() => {
        followPointer();
        for (const item of row.querySelectorAll<HTMLElement>(itemSelector)) {
          if (item === el) continue;
          const prev = before.get(item);
          if (prev === undefined) continue;
          const delta = prev - item.getBoundingClientRect().left;
          if (delta === 0) continue;
          item.animate([{ transform: `translateX(${delta}px)` }, { transform: "none" }], {
            duration: 120,
            easing: "ease-out",
          });
        }
      });
    };
    const stopDrag = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", stopDrag);
      stopDragRef.current = null;
      // Settle into the slot instead of vanishing there.
      if (translate !== 0) {
        el.animate([{ transform: `translateX(${translate}px)` }, { transform: "none" }], {
          duration: 120,
          easing: "ease-out",
        });
      }
      el.style.transform = "";
      setDraggingId(null);
    };

    stopDragRef.current?.();
    stopDragRef.current = stopDrag;
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", stopDrag);
  };

  return { draggingId, startDrag, wasDragged: () => draggedRef.current };
}
