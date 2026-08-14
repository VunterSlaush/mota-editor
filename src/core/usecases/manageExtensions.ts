import type { ExtensionHostEvent, ExtensionHostPort } from "../ports/extensionHost";
import type { NotificationPort } from "../ports/notificationPort";
import type { Store } from "../state/store";

/**
 * Use case — the lifecycle of installed extensions: load the list into
 * state, enable/disable, and serve the host's callbacks (a notification
 * an extension asked for is fulfilled HERE, through the same port every
 * other notification uses, then answered back to the host).
 */
export class ManageExtensions {
  constructor(
    private readonly store: Store,
    private readonly extensionHost: ExtensionHostPort,
    private readonly notifications: NotificationPort,
  ) {
    extensionHost.subscribe((extensionId, event) => this.onEvent(extensionId, event));
  }

  /** Discover and load every extension into state. Failures degrade to
   *  an empty list — extensions are never load-bearing. */
  async load(): Promise<void> {
    const paths = this.store.getState().tabs.map((t) => t.project.path);
    const extensions = await this.extensionHost.list(paths).catch(() => []);
    this.store.dispatch({ type: "extensions/loaded", extensions });
  }

  /** Ask the backend to enable — the consent dialog is native, so this
   *  resolves only after the user answered it. */
  async enable(id: string): Promise<void> {
    try {
      await this.extensionHost.enable(id);
    } catch {
      // Cancelled or failed — the reload below shows the true status.
    }
    await this.load();
  }

  async disable(id: string): Promise<void> {
    await this.extensionHost.disable(id).catch(() => undefined);
    await this.load();
  }

  readLog(id: string): Promise<string> {
    return this.extensionHost.readLog(id).catch(() => "");
  }

  private onEvent(extensionId: string, event: ExtensionHostEvent): void {
    switch (event.kind) {
      case "statusChanged":
        this.store.dispatch({
          type: "extensions/statusChanged",
          extensionId,
          status: event.status,
          error: event.error,
        });
        break;
      case "notifyRequested":
        void this.notifications
          .show(event.title, event.body)
          .catch(() => undefined)
          .then(() => this.extensionHost.respond(extensionId, event.requestId, {}))
          .catch(() => undefined);
        break;
    }
  }
}
