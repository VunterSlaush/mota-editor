/**
 * Entities layer — a line typed at the prompt that is meant for the
 * user's own shell rather than for the agent, the way "!" works in
 * Claude Code. Asking an agent to run `git status` costs a turn, a
 * round trip and a permission prompt to learn something the shell
 * would have said instantly.
 *
 * The "!" has to be the draft's first character, with no leading space.
 * That is the escape hatch as much as the rule: a prompt that genuinely
 * opens with "!" still reaches the agent if it starts with a space.
 */

const PREFIX = "!";

/** Whether this draft is aimed at the shell rather than at the agent. */
export function isShellLine(draft: string): boolean {
  return draft.startsWith(PREFIX);
}

/** The command a shell line carries; "" when the "!" stands alone. */
export function shellCommand(draft: string): string {
  return isShellLine(draft) ? draft.slice(PREFIX.length).trim() : "";
}

/**
 * The keystrokes that run a command in a pty.
 *
 * Enter is CR there, not LF, so a command pasted into the composer over
 * several lines has to be translated on the way — a shell handed a raw
 * newline mid-line does not always read it as "run this".
 */
export function shellKeystrokes(command: string): string {
  return `${command.replace(/\r?\n/g, "\r")}\r`;
}
