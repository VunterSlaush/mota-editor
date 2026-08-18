/**
 * Entities layer — jumping to a tab by its position on the strip, the
 * Ctrl+1…Ctrl+8 every browser and editor binds.
 *
 * Position, not identity: the number names a seat in the strip, so
 * reordering tabs reorders their shortcuts too. That is what makes the
 * binding worth having — the leftmost tab is always Ctrl+1, however
 * many times the set of open projects has changed.
 */

/** How far along the strip the number row reaches. Past this, click. */
export const MAX_TAB_SHORTCUT = 8;

/** The parts of a keyboard event this decision reads. */
export interface TabShortcutKey {
  readonly key: string;
  /** Layout-independent, so AZERTY and the keypad work too. */
  readonly code?: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey?: boolean;
  readonly shiftKey?: boolean;
}

/**
 * The tab position a keystroke asks for, counting from zero, or null
 * when it asks for none.
 *
 * Alt and Shift disqualify: AltGr arrives as Ctrl+Alt and types digits
 * on several layouts, and Ctrl+Shift+<digit> is a different gesture
 * whose `code` looks identical to this one.
 */
export function tabShortcutIndex(e: TabShortcutKey): number | null {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return null;
  const digit = pressedDigit(e);
  // 0 is the zoom reset (see `zoomIntent`), and there is no zeroth tab.
  if (digit === null || digit < 1 || digit > MAX_TAB_SHORTCUT) return null;
  return digit - 1;
}

/**
 * The digit under the finger. `code` first: it names the physical key,
 * so this still reads "1" on a layout whose unshifted top row types
 * punctuation. `key` is the fallback for events that carry no code.
 */
function pressedDigit(e: TabShortcutKey): number | null {
  const physical = e.code?.match(/^(?:Digit|Numpad)(\d)$/);
  if (physical) return Number(physical[1]);
  return /^\d$/.test(e.key) ? Number(e.key) : null;
}
