import type { WindowPort } from "../ports/windowPort";
import type { TabState } from "../state/appState";
import { workingTabs } from "../state/appState";
import type { Store } from "../state/store";

/**
 * Use case — leaving the app.
 *
 * Agent turns die with the process: there is no background run to come
 * back to, and no way to reattach to one that was killed mid-tool-call.
 * A window closed while a tab is still working therefore throws away
 * work the user may not even know is running — which is the only reason
 * this asks anything at all. With every tab idle it gets out of the way.
 */
export class QuitApp {
  constructor(
    private readonly store: Store,
    private readonly window: WindowPort,
  ) {}

  /**
   * Take over the window's close button. `onBlocked` is called with the
   * tabs still working, instead of closing, whenever there are any.
   */
  guard(onBlocked: (working: readonly TabState[]) => void): void {
    this.window.onCloseRequested(() => {
      const working = workingTabs(this.store.getState());
      if (working.length === 0) {
        void this.execute();
        return;
      }
      onBlocked(working);
    });
  }

  /** Leave, whatever is running. */
  async execute(): Promise<void> {
    await this.window.close();
  }
}
