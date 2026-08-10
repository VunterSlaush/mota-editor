import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ShellOpenRequest,
  ShellPort,
  ShellSize,
  ShellStream,
} from "../../core/ports/shellPort";

/** What the backend puts on the wire; converted below, never passed on. */
interface WireShellEvent {
  readonly sessionId: string;
  readonly kind: "output" | "exit";
  /** Base64 on `output`: a chunk boundary lands mid-character constantly,
   *  and a string on the wire would have to guess. */
  readonly data?: string;
  readonly exitCode?: number;
}

/**
 * Adapter — the user's terminal over Tauri: `shell_*` commands down, one
 * `shell-event` topic up.
 */
export class TauriShell implements ShellPort {
  /**
   * One process-wide listener fans out by session id, for the same
   * reason `TauriAgentGateway` does: a listener per terminal is a
   * listener to leak every time one closes.
   */
  private readonly streams = new Map<string, ShellStream>();
  /**
   * Output that arrived before its stream registered. A shell writes its
   * prompt the instant it starts, which can beat `invoke`'s reply back
   * to us; without this the first thing the user sees is a blank panel.
   */
  private readonly early = new Map<string, WireShellEvent[]>();
  private listening: Promise<UnlistenFn> | null = null;

  private async ensureListener(): Promise<void> {
    this.listening ??= listen<WireShellEvent>("shell-event", ({ payload }) => {
      const stream = this.streams.get(payload.sessionId);
      if (!stream) {
        const parked = this.early.get(payload.sessionId) ?? [];
        parked.push(payload);
        this.early.set(payload.sessionId, parked);
        return;
      }
      deliver(stream, payload);
      if (payload.kind === "exit") this.forget(payload.sessionId);
    });
    await this.listening;
  }

  async open(request: ShellOpenRequest, stream: ShellStream): Promise<string> {
    await this.ensureListener();
    const sessionId = await invoke<string>("shell_open", {
      args: {
        projectId: request.projectId,
        cwd: request.cwd,
        shellPath: request.shellPath,
        cols: request.size.cols,
        rows: request.size.rows,
      },
    });
    this.streams.set(sessionId, stream);
    for (const parked of this.early.get(sessionId) ?? []) {
      deliver(stream, parked);
      if (parked.kind === "exit") this.forget(sessionId);
    }
    this.early.delete(sessionId);
    return sessionId;
  }

  async write(sessionId: string, data: string): Promise<void> {
    await invoke("shell_write", { sessionId, data });
  }

  async resize(sessionId: string, size: ShellSize): Promise<void> {
    await invoke("shell_resize", { sessionId, cols: size.cols, rows: size.rows });
  }

  async close(sessionId: string): Promise<void> {
    this.forget(sessionId);
    await invoke("shell_close", { sessionId });
  }

  async closeProject(projectId: string): Promise<void> {
    await invoke("shell_close_project", { projectId });
  }

  private forget(sessionId: string): void {
    this.streams.delete(sessionId);
    this.early.delete(sessionId);
  }
}

function deliver(stream: ShellStream, event: WireShellEvent): void {
  if (event.kind === "exit") {
    stream.onExit(event.exitCode ?? null);
    return;
  }
  if (event.data) stream.onOutput(decodeBase64(event.data));
}

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
