/** The part of a DOMRect placement needs. */
export interface HostRect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
  readonly width: number;
  readonly height: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

/** Space between the host and its tooltip. */
const GAP = 6;
/** How close to the window's edge a tooltip may get. */
const MARGIN = 8;

/**
 * Where to draw a tooltip for the thing being hovered: under it and
 * centred, flipped above when the window's bottom is in the way, and
 * always inside the window. Pure arithmetic, kept out of the component
 * so the awkward cases (a control at the bottom edge, a tooltip wider
 * than the window) can be tested without a DOM.
 */
export function tooltipPlacement(
  host: HostRect,
  tip: Size,
  viewport: Size,
): { left: number; top: number } {
  const below = host.bottom + GAP;
  const above = host.top - tip.height - GAP;
  const fitsBelow = below + tip.height <= viewport.height - MARGIN;
  const top = clamp(fitsBelow ? below : above, MARGIN, viewport.height - MARGIN);
  const centred = host.left + host.width / 2 - tip.width / 2;
  const left = clamp(centred, MARGIN, viewport.width - tip.width - MARGIN);
  return { left, top };
}

/** Low wins over high, so a tooltip too big to fit stays at the margin. */
function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(value, high));
}
