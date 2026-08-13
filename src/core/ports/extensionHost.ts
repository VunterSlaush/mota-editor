import type { ExtensionDescriptor, ExtensionStatus } from "../entities/extension";

/**
 * Ports layer — boundary interface the use cases call to talk to the
 * extension host. Implemented by an outer-layer adapter (the Tauri host
 * of ADR-0012, or the in-memory demo). The core never learns which one
 * it is talking to, and never sees the wire protocol — descriptors and
 * events arrive already translated.
 */

/** Something the host pushed about one extension. */
export type ExtensionHostEvent =
  | {
      readonly kind: "statusChanged";
      readonly status: ExtensionStatus;
      readonly error?: string;
    }
  | {
      readonly kind: "notifyRequested";
      readonly requestId: string;
      readonly title: string;
      readonly body: string;
    }
  | {
      /** The extension asked for its panel to be re-pulled. */
      readonly kind: "panelChanged";
      readonly panelId?: string;
    };

/** One user interaction inside a panel (ADR-0013's tiny vocabulary):
 *  `open` — an item was clicked; `select` — its dropdown changed. */
export interface PanelActionRequest {
  readonly action: "open" | "select";
  readonly itemId: string;
  readonly value?: string;
}

export interface ExtensionHostPort {
  /** Every installed extension, across these projects and the user dir. */
  list(projectPaths: readonly string[]): Promise<ExtensionDescriptor[]>;
  /**
   * Enable by id — nothing else crosses. The backend re-reads the
   * manifest and asks the user in a NATIVE dialog; this side can request
   * but never approve.
   */
  enable(id: string): Promise<ExtensionDescriptor>;
  disable(id: string): Promise<void>;
  /** Run a programmatic command; resolves to the raw action payload. */
  invokeCommand(
    extensionId: string,
    command: string,
    args: string,
    tabId: string,
    projectPath: string,
  ): Promise<unknown>;
  /** Ask a panel for its view model; resolves to the raw payload. */
  loadPanel(
    extensionId: string,
    panelId: string,
    tabId: string,
    projectPath: string,
  ): Promise<unknown>;
  /** Route one panel interaction; resolves to the raw payload. */
  panelAction(
    extensionId: string,
    panelId: string,
    request: PanelActionRequest,
    tabId: string,
    projectPath: string,
  ): Promise<unknown>;
  /** Fan a workbench event out to subscribed extensions. */
  publishEvent(event: string, payload: unknown): Promise<void>;
  /** May be called by several use cases — every listener is kept. */
  subscribe(listener: (extensionId: string, event: ExtensionHostEvent) => void): void;
  /** Answer a host request the frontend fulfilled (`notifyRequested`). */
  respond(extensionId: string, requestId: string, result: unknown): Promise<void>;
  readLog(extensionId: string): Promise<string>;
}
