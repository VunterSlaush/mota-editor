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
    };

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
  /** Fan a workbench event out to subscribed extensions. */
  publishEvent(event: string, payload: unknown): Promise<void>;
  subscribe(listener: (extensionId: string, event: ExtensionHostEvent) => void): void;
  /** Answer a host request the frontend fulfilled (`notifyRequested`). */
  respond(extensionId: string, requestId: string, result: unknown): Promise<void>;
  readLog(extensionId: string): Promise<string>;
}
