import { getCurrentWindow } from "@tauri-apps/api/window";
import type { WindowPort } from "../../core/ports/windowPort";

/**
 * Interface adapter — the main window's close gesture.
 *
 * `destroy`, not `close`: Tauri's `close` re-raises the very
 * close-requested event this listener answers, so quitting through it
 * would ask the user the same question forever.
 */
export class TauriWindow implements WindowPort {
  private handler: (() => void) | null = null;
  private listening = false;

  onCloseRequested(handler: () => void): void {
    // One native listener for the life of the process, with the latest
    // handler in it. Registering a second would run every handler a
    // remount ever installed, each one prompting.
    this.handler = handler;
    if (this.listening) return;
    this.listening = true;
    void getCurrentWindow().onCloseRequested((event) => {
      event.preventDefault();
      this.handler?.();
    });
  }

  async close(): Promise<void> {
    await getCurrentWindow().destroy();
  }
}
