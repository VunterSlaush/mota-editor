/**
 * Ports layer — the application window itself.
 *
 * Only the one gesture the app has to answer rather than obey: the OS
 * close button. Everything the window does that is purely cosmetic
 * (title, size, position) stays the shell's business.
 */
export interface WindowPort {
  /**
   * Take over the close gesture: the window stops closing on its own and
   * `handler` decides instead. `close()` is the only way out from then
   * on, and it never asks the handler again.
   *
   * Registered once — there is one window, and one owner of this
   * decision. Calling it again replaces the handler rather than adding
   * a second one, so a view that re-registers on remount is safe.
   */
  onCloseRequested(handler: () => void): void;

  /** Close for real. */
  close(): Promise<void>;
}
