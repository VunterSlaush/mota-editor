import type { Size } from "./tooltipPlacement";

/** Where the secondary click landed, in viewport coordinates. */
export interface Point {
  readonly x: number;
  readonly y: number;
}

/** How close to the window's edge a menu may get. */
const MARGIN = 8;

/**
 * Where to draw a context menu for a click at `cursor`: top-left corner on
 * the pointer, flipped to the other side of it when the window's edge is
 * in the way, and always inside the window.
 *
 * A tooltip is centred under what it describes; a menu is not — it hangs
 * off the pointer, so the first item is under the finger that opened it.
 * That is the whole reason this is not `tooltipPlacement`. Pure
 * arithmetic, kept out of the component so the awkward cases (a click by
 * the bottom edge, a menu taller than the window) can be tested without a
 * DOM.
 */
export function contextMenuPlacement(
  cursor: Point,
  menu: Size,
  viewport: Size,
): { left: number; top: number } {
  return {
    left: place(cursor.x, menu.width, viewport.width),
    top: place(cursor.y, menu.height, viewport.height),
  };
}

/** One axis: after the pointer if it fits, before it if that fits better,
 *  and never past the margin at either end. */
function place(at: number, extent: number, available: number): number {
  const after = at;
  const before = at - extent;
  const fitsAfter = after + extent <= available - MARGIN;
  return clamp(fitsAfter ? after : before, MARGIN, available - extent - MARGIN);
}

/** Low wins over high, so a menu too big to fit stays at the margin. */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}
