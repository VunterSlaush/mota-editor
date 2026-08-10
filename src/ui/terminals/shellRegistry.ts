import type { XtermSession } from "./xtermSession";

/**
 * UI — the live xterm instances, by shell session id.
 *
 * Module-level rather than React state on purpose. `ChatPanel` is keyed
 * by project id, so switching projects unmounts it; the terminal panel
 * also unmounts every time it is closed. A `Terminal` cannot survive
 * either as component state, and losing it would throw away the
 * scrollback of a build the user is still reading. The pty outlives the
 * view, so its renderer has to as well.
 *
 * The core owns which sessions exist; this only holds their renderers,
 * and `remove` is called from the same place the session is closed.
 */
const sessions = new Map<string, XtermSession>();

export function rememberXterm(sessionId: string, session: XtermSession): void {
  sessions.get(sessionId)?.dispose();
  sessions.set(sessionId, session);
}

export function xtermFor(sessionId: string): XtermSession | undefined {
  return sessions.get(sessionId);
}

export function forgetXterm(sessionId: string): void {
  sessions.get(sessionId)?.dispose();
  sessions.delete(sessionId);
}

/** Re-read the palette and font size after the user changes either. */
export function restyleAll(fontSize: number): void {
  for (const session of sessions.values()) session.restyle(fontSize);
}
