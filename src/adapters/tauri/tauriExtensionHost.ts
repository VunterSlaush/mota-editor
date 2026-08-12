import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ExtensionDescriptor,
  ExtensionPermission,
  ExtensionStatus,
} from "../../core/entities/extension";
import type {
  ExtensionHostEvent,
  ExtensionHostPort,
} from "../../core/ports/extensionHost";

/**
 * Interface adapter — the Rust extension host (ADR-0012) behind the
 * ExtensionHostPort. Wire shapes convert to domain descriptors HERE;
 * the core never sees the channel or the JSON-RPC underneath it.
 */

/** What `extensions_list` returns per extension (Rust `ExtensionDescriptorWire`). */
interface WireDescriptor {
  id: string;
  displayName: string;
  version: string;
  description: string;
  origin: "user" | "project";
  projectPath: string | null;
  path: string;
  permissions: string[];
  status: string;
  error: string | null;
  commands: {
    name: string;
    description: string;
    argsHint: string | null;
    kind: string;
    template: string | null;
  }[];
  mcpServers: {
    name: string;
    command: string;
    args: string[];
    env: Record<string, string>;
  }[];
  events: string[];
}

/** One `extension-event` payload (Rust `WireEvent` + `ExtensionUiEvent`). */
interface WireEvent {
  extensionId: string;
  event:
    | { type: "statusChanged"; status: string; error?: string }
    | { type: "notifyRequested"; requestId: string; title: string; body: string }
    | { type: "logLine"; line: string };
}

const KNOWN_STATUSES: readonly ExtensionStatus[] = [
  "needs-approval",
  "disabled",
  "enabled",
  "running",
  "crashed",
  "invalid",
  "incompatible",
];

function toDomainStatus(status: string): ExtensionStatus {
  return (KNOWN_STATUSES as readonly string[]).includes(status)
    ? (status as ExtensionStatus)
    : "invalid";
}

function toDomainDescriptor(wire: WireDescriptor): ExtensionDescriptor {
  return {
    id: wire.id,
    displayName: wire.displayName,
    version: wire.version,
    description: wire.description,
    origin: wire.origin,
    projectPath: wire.projectPath ?? undefined,
    path: wire.path,
    // The backend validated these against its closed vocabulary; the
    // cast converts the wire strings to the domain union.
    permissions: wire.permissions as readonly ExtensionPermission[],
    status: toDomainStatus(wire.status),
    error: wire.error ?? undefined,
    commands: wire.commands.map((c) => ({
      name: c.name,
      description: c.description,
      argsHint: c.argsHint ?? undefined,
      kind: c.kind === "programmatic" ? "programmatic" : "prompt",
      template: c.template ?? undefined,
    })),
    mcpServers: wire.mcpServers,
    events: wire.events,
  };
}

export class TauriExtensionHost implements ExtensionHostPort {
  private handler: ((extensionId: string, event: ExtensionHostEvent) => void) | null =
    null;
  private listening = false;

  subscribe(listener: (extensionId: string, event: ExtensionHostEvent) => void): void {
    this.handler = listener;
    if (this.listening) return;
    this.listening = true;
    void listen<WireEvent>("extension-event", ({ payload }) => {
      const event = payload.event;
      switch (event.type) {
        case "statusChanged":
          this.handler?.(payload.extensionId, {
            kind: "statusChanged",
            status: toDomainStatus(event.status),
            error: event.error,
          });
          break;
        case "notifyRequested":
          this.handler?.(payload.extensionId, {
            kind: "notifyRequested",
            requestId: event.requestId,
            title: event.title,
            body: event.body,
          });
          break;
        default:
          break; // logLine and future events — the settings log covers it
      }
    });
  }

  async list(projectPaths: readonly string[]): Promise<ExtensionDescriptor[]> {
    const wire = await invoke<WireDescriptor[]>("extensions_list", {
      projectPaths: [...projectPaths],
    });
    return wire.map(toDomainDescriptor);
  }

  async enable(id: string): Promise<ExtensionDescriptor> {
    return toDomainDescriptor(await invoke<WireDescriptor>("extension_enable", { id }));
  }

  async disable(id: string): Promise<void> {
    await invoke("extension_disable", { id });
  }

  invokeCommand(
    extensionId: string,
    command: string,
    args: string,
    tabId: string,
    projectPath: string,
  ): Promise<unknown> {
    return invoke("extension_invoke_command", {
      extensionId,
      command,
      args,
      tabId,
      projectPath,
    });
  }

  async publishEvent(event: string, payload: unknown): Promise<void> {
    await invoke("extension_publish_event", { event, payload });
  }

  async respond(extensionId: string, requestId: string, result: unknown): Promise<void> {
    await invoke("extension_respond", { extensionId, requestId, result });
  }

  readLog(extensionId: string): Promise<string> {
    return invoke<string>("extension_read_log", { extensionId });
  }
}
