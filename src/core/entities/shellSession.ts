import type { InputLine } from "./inputLine";

/**
 * Entities layer — one terminal the user opened in a project.
 *
 * "Shell" is the user's word here and "terminal" is the agent's: a
 * `ShellSession` is something a human types into, while the agent's
 * captured commands are terminals (`AgentGateway.readTerminalOutput`).
 * Two names because they are two things — the agent can reach one and
 * not the other. The UI still labels this one "Terminal", because that
 * is what a person calls it.
 */
export interface ShellSession {
  readonly id: string;
  /** What the tab strip shows: "Terminal 1", "Terminal 2"… */
  readonly title: string;
  /** True while a submitted command still has the shell — see
   *  `shellRunningAfter`. */
  readonly running?: boolean;
  /**
   * Set once the shell exited. The session stays in the list until the
   * user closes it, so the last output can still be read — a build that
   * failed is exactly when its scrollback matters. `code` is null when
   * the shell was killed rather than returning a status.
   */
  readonly exit?: { readonly code: number | null };
}

/**
 * The lowest "Terminal N" nobody is using. Reusing a freed number keeps
 * the strip readable — open three, close the second, and the next one
 * fills the gap instead of climbing to four.
 */
export function nextShellTitle(existing: readonly ShellSession[]): string {
  const taken = new Set(existing.map((session) => session.title));
  for (let n = 1; ; n += 1) {
    const title = `Terminal ${n}`;
    if (!taken.has(title)) return title;
  }
}

/** What to show once a shell is gone, or "" while it is still running. */
export function shellExitLabel(session: ShellSession): string {
  if (!session.exit) return "";
  const { code } = session.exit;
  if (code === null) return "exited";
  return code === 0 ? "exited" : `exited (${code})`;
}

/**
 * Whether a command still has the shell, after these keystrokes.
 *
 * Nothing asks the operating system what the pty's foreground process
 * is: there is no answer to that question on Windows without walking the
 * process tree, and we already watch every byte the user sends. So this
 * reads the user instead of the machine — submitting a command starts
 * it, and typing again means the prompt came back, because a shell that
 * is still busy has nothing to type into. `line` comes from the same
 * keystrokes (see `typeInto`) and is what tells an empty Enter from a
 * real command.
 *
 * It is a model, so it can be wrong: a short command reads as running
 * until the next keystroke, and typing into a full-screen program reads
 * as finished. Both are visible on screen at the moment they mislead,
 * which is why a wrong dot here costs nothing — while a long build or a
 * dev server, the thing worth showing, it gets right.
 */
export function shellRunningAfter(
  running: boolean,
  keystrokes: string,
  line: InputLine,
): boolean {
  if (line.submitted.length > 0) return true;
  for (const key of keystrokes) {
    if (key === "\x1b") break; // an escape sequence: a key, not typing
    if (key === "\x03") return false; // Ctrl+C — how a server is stopped
    if (key >= " ") return false; // typing, so the prompt is back
  }
  return running;
}

/**
 * Which session to look at after `closedId` goes. The neighbour to the
 * left, because that is the one the user was most likely working in
 * before; the right-hand one when there is nothing to the left.
 */
export function shellAfterClosing(
  sessions: readonly ShellSession[],
  closedId: string,
): string | undefined {
  const index = sessions.findIndex((session) => session.id === closedId);
  if (index === -1) return sessions[0]?.id;
  const remaining = sessions.filter((session) => session.id !== closedId);
  return remaining[Math.max(0, index - 1)]?.id;
}
