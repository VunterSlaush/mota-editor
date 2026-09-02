/**
 * Entities layer — what Ctrl+F means inside a terminal.
 *
 * It is a key with a prior claim: readline binds it to forward-char, and
 * `less` and `vim` page forward with it. Taking it costs those, and every
 * terminal that offers a find bar has paid the same price — VS Code,
 * iTerm and Windows Terminal all bind it — because scrolling back through
 * a build looking for the one line that said "error" is the more common
 * need, and the alternatives readline offers (Right arrow, Space, Ctrl+D)
 * are all still there.
 *
 * On macOS the price is not paid at all: Cmd is the application's
 * modifier there, so Ctrl+F stays the shell's, exactly as Ctrl+C does for
 * the clipboard (see `terminalClipboard`).
 */

export type TerminalSearchIntent = "open";

/** The parts of a keyboard event this decision reads. */
export interface TerminalSearchKey {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
}

export interface TerminalSearchContext {
  /** macOS puts application shortcuts on Cmd and leaves Ctrl to the
   *  shell — there, Ctrl+F must still be forward-char. */
  readonly isMac: boolean;
}

/**
 * Whether a keystroke is asking for the find bar, or null when it asks
 * for nothing and the terminal should have the key untouched.
 *
 * Shift is allowed rather than required: Ctrl+Shift+F is what Windows
 * Terminal binds, and someone arriving with that habit should not find
 * a dead key. Alt disqualifies, because AltGr arrives as Ctrl+Alt on
 * several layouts and types ordinary characters that must reach the shell
 * as themselves.
 */
export function terminalSearchIntent(
  e: TerminalSearchKey,
  { isMac }: TerminalSearchContext,
): TerminalSearchIntent | null {
  if (e.altKey) return null;
  // Exactly one of the two, so Ctrl+Cmd+F is nobody's shortcut.
  const modified = isMac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
  if (!modified) return null;
  return e.key.toLowerCase() === "f" ? "open" : null;
}
