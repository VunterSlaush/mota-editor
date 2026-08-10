/**
 * Ports layer — where the user's past commands come from.
 *
 * The shell's own history file, read and never written. The shell keeps
 * it current on its own, including the commands run in our terminal, so
 * a copy of ours would only be a second thing to get out of step.
 */
export interface ShellHistorySource {
  /** Recent commands, oldest first. Empty when there is no history. */
  recent(): Promise<readonly string[]>;
}
