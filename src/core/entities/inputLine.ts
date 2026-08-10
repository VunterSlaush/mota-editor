/**
 * Entities layer — what we believe the user has typed at the prompt.
 *
 * We never ask the shell. We know because we are the ones who sent the
 * keystrokes: every byte the terminal writes passes through here first.
 * That avoids shell-integration escape sequences entirely, at the price
 * of being a *model* of the shell's line editor rather than the thing
 * itself.
 *
 * So the model fails closed. Anything we cannot account for — an arrow
 * key, Tab completion, Ctrl+R, a resize redraw — sets `text` to null,
 * meaning "no idea", and suggestions stop until the next fresh line. A
 * missing suggestion is a shrug; a suggestion computed from a line we
 * have guessed wrong would insert text the user never asked for, and
 * that is the failure this shape exists to make impossible.
 */
export interface InputLine {
  /** The line so far, or null once we lost track of it. */
  readonly text: string | null;
  /**
   * Lines finished by the keystrokes just applied. Usually none or one;
   * pasting a script submits several at once.
   */
  readonly submitted: readonly string[];
}

const NOTHING: readonly string[] = [];

/** A fresh prompt: empty, and known to be empty. */
export const EMPTY_LINE: InputLine = { text: "", submitted: NOTHING };

/** Lost track: no suggestions until a new line starts. */
const UNKNOWN: InputLine = { text: null, submitted: NOTHING };

/**
 * Fold a chunk of keystrokes into the model. `data` is exactly what goes
 * to the pty, so it may hold several characters — a paste, or an escape
 * sequence arriving as one string.
 */
export function typeInto(current: InputLine, data: string): InputLine {
  let text = current.text;
  const submitted: string[] = [];

  for (const key of data) {
    if (key === "\r" || key === "\n") {
      const line = text?.trim();
      if (line) submitted.push(line);
      text = "";
      continue;
    }
    if (text === null) continue; // already lost; nothing to update
    if (key === "\x03") {
      text = ""; // Ctrl+C abandons the line and starts a new prompt
    } else if (key === "\x7f" || key === "\b") {
      text = text.slice(0, -1);
    } else if (key >= " ") {
      text += key;
    } else {
      // A control byte we do not model — Tab, an arrow, Ctrl+R. The
      // shell will do something to the line that we cannot predict.
      text = null;
    }
  }

  if (text === null && submitted.length === 0) return UNKNOWN;
  return { text, submitted: submitted.length > 0 ? submitted : NOTHING };
}
