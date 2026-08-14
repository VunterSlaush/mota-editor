import type { ExtensionPanelRef } from "../entities/extension";
import {
  type PanelActionResult,
  type PanelView,
  parsePanelActionResult,
  parsePanelView,
} from "../entities/extensionPanels";
import type { ExtensionHostPort, PanelActionRequest } from "../ports/extensionHost";

/**
 * Use case — one extension panel's conversation with its process: pull
 * the view, route an interaction, and surface the extension's push
 * ("something changed, re-pull me"). The untrusted payloads become typed
 * view models HERE, so the UI below stays humble.
 */
export class ExtensionPanels {
  private listeners: ((extensionId: string, panelId?: string) => void)[] = [];

  constructor(private readonly extensionHost: ExtensionHostPort) {
    extensionHost.subscribe((extensionId, event) => {
      if (event.kind !== "panelChanged") return;
      for (const listener of this.listeners) listener(extensionId, event.panelId);
    });
  }

  async load(
    ref: ExtensionPanelRef,
    tabId: string,
    projectPath: string,
  ): Promise<PanelView> {
    const payload = await this.extensionHost.loadPanel(
      ref.extensionId,
      ref.panelId,
      tabId,
      projectPath,
    );
    return parsePanelView(viewOf(payload));
  }

  async action(
    ref: ExtensionPanelRef,
    request: PanelActionRequest,
    tabId: string,
    projectPath: string,
  ): Promise<PanelActionResult> {
    const payload = await this.extensionHost.panelAction(
      ref.extensionId,
      ref.panelId,
      request,
      tabId,
      projectPath,
    );
    return parsePanelActionResult(payload);
  }

  /** Notifies when an extension asks for a re-pull (`panels/refresh`).
   *  Returns the unsubscribe — the panel view mounts and unmounts. */
  onPanelChanged(listener: (extensionId: string, panelId?: string) => void): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((entry) => entry !== listener);
    };
  }
}

function viewOf(payload: unknown): unknown {
  return typeof payload === "object" && payload !== null
    ? (payload as { view?: unknown }).view
    : undefined;
}
