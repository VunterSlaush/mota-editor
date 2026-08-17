/**
 * Entities layer — what Ctrl+C and Ctrl+V mean inside a terminal.
 *
 * A terminal is the one place where the copy shortcut is already taken:
 * Ctrl+C is how you interrupt a running program, and has been for longer
 * than clipboards have existed. Every terminal that resolves this
 * resolves it the same way — copy when there is a selection to copy,
 * interrupt when there is not — so the key keeps both jobs and the
 * selection is what says which one is meant.
 *
 * Paste has no such conflict and is taken unconditionally; left alone,
 * xterm sends Ctrl+V to the shell as a control character and the
 * webview's own paste never happens.
 */

export type TerminalClipboardIntent = "copy" | "paste";

/** The parts of a keyboard event this decision reads. */
export interface TerminalClipboardKey {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export interface TerminalClipboardContext {
  /** Whether the terminal currently has text selected. */
  readonly hasSelection: boolean;
  /** macOS puts this on Cmd and leaves Ctrl to the shell — there,
   *  Ctrl+C must stay the interrupt whatever is selected. */
  readonly isMac: boolean;
}

/**
 * What a keystroke asks the clipboard for, or null when it asks for
 * nothing and the terminal should have the key untouched.
 *
 * Alt disqualifies: AltGr arrives as Ctrl+Alt on several layouts and
 * types ordinary characters, which must reach the shell as themselves.
 */
export function terminalClipboardIntent(
  e: TerminalClipboardKey,
  { hasSelection, isMac }: TerminalClipboardContext,
): TerminalClipboardIntent | null {
  if (e.altKey) return null;
  // Exactly one of the two, so Ctrl+Cmd+C is nobody's shortcut.
  const modified = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!modified) return null;

  const key = e.key.toLowerCase();
  if (key === "v") return "paste";
  if (key !== "c") return null;
  // Ctrl+Shift+C is the unambiguous copy every terminal offers, and says
  // nothing to the shell — so it copies even with nothing selected
  // (harmlessly) rather than falling through to the interrupt.
  if (e.shiftKey) return "copy";
  return hasSelection ? "copy" : null;
}
