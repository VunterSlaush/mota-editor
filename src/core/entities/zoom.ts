/**
 * Entities layer — interface zoom, VS Code's model: an integer level the
 * user steps through, and a scale factor of 1.2^level. Levels rather
 * than percentages so that stepping in and back out lands exactly where
 * it started, which repeated multiplication of a factor does not.
 */

/** 1.2^-5 ≈ 0.40 — past this the interface is no longer usable. */
export const MIN_ZOOM_LEVEL = -5;
/** 1.2^8 ≈ 4.3 — VS Code's ceiling, and past any real need. */
export const MAX_ZOOM_LEVEL = 8;
/** Untouched. */
export const DEFAULT_ZOOM_LEVEL = 0;

/** One notch, the same ratio Chrome and VS Code step by. */
const STEP = 1.2;

/** A level inside the usable range, rounded to a whole notch. */
export function clampZoomLevel(level: number): number {
  if (!Number.isFinite(level)) return DEFAULT_ZOOM_LEVEL;
  return Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, Math.round(level)));
}

/** What to scale the interface by, 1 being untouched. */
export function zoomFactor(level: number): number {
  return STEP ** clampZoomLevel(level);
}

/** How the current level reads to a person: 100%, 120%, 83%. */
export function zoomPercent(level: number): number {
  return Math.round(zoomFactor(level) * 100);
}

/** What a zoom shortcut asks for. */
export type ZoomIntent = "in" | "out" | "reset";

/** The parts of a keyboard event this decision reads. */
export interface ZoomKey {
  readonly key: string;
  /** Layout-independent, so the numeric keypad works everywhere. */
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey?: boolean;
}

/**
 * The zoom a keystroke asks for, or null when it asks for none.
 *
 * Both the main row and the keypad are accepted, and so is "+" as well
 * as "=": on most layouts the key that means "bigger" is only "+" with
 * Shift held, and nobody reaches for Shift on purpose here.
 */
export function zoomIntent(e: ZoomKey): ZoomIntent | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey) return null;
  if (e.key === "+" || e.key === "=" || e.code === "NumpadAdd") return "in";
  if (e.key === "-" || e.key === "_" || e.code === "NumpadSubtract") return "out";
  if (e.key === "0" || e.code === "Numpad0") return "reset";
  return null;
}

/** The level a zoom shortcut moves to from where it is now. */
export function applyZoomIntent(level: number, intent: ZoomIntent): number {
  if (intent === "reset") return DEFAULT_ZOOM_LEVEL;
  return clampZoomLevel(clampZoomLevel(level) + (intent === "in" ? 1 : -1));
}
