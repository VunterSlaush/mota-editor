import { nextShellTitle } from "../entities/shellSession";
import type { ShellPort, ShellSize } from "../ports/shellPort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * What the view supplies when it asks for a terminal: how big it is, and
 * where the bytes should land. The sink is a callback rather than state
 * on purpose — routing a build log through the reducer would re-render
 * the whole app on every frame of output.
 */
export interface OpenShellRequest {
  readonly size: ShellSize;
  readonly onOutput: (bytes: Uint8Array) => void;
}

export type OpenShellResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly message: string };

/**
 * Use case — the user's terminals: open one in the project's folder,
 * carry keystrokes to it, and make sure it dies when it should.
 */
export class Shells {
  constructor(
    private readonly store: Store,
    private readonly shells: ShellPort,
  ) {}

  async open(tabId: string, request: OpenShellRequest): Promise<OpenShellResult> {
    const state = this.store.getState();
    const tab = tabById(state, tabId);
    if (!tab) return { ok: false, message: "Unknown tab." };
    const title = nextShellTitle(tab.shells);

    // A shell can die before `open` has even resolved — a misconfigured
    // shell path starts and exits at once — so the exit is held until
    // there is an id to attach it to.
    let sessionId: string | undefined;
    let exitedEarly: { code: number | null } | undefined;
    const markExited = (code: number | null) => {
      if (sessionId === undefined) {
        exitedEarly = { code };
        return;
      }
      this.store.dispatch({ type: "shell/exited", tabId, sessionId, code });
    };

    try {
      sessionId = await this.shells.open(
        {
          projectId: tabId,
          cwd: tab.project.path,
          shellPath: state.settings.terminalShell.trim() || undefined,
          size: request.size,
        },
        { onOutput: request.onOutput, onExit: markExited },
      );
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : String(e) };
    }

    this.store.dispatch({
      type: "shell/opened",
      tabId,
      session: { id: sessionId, title },
    });
    if (exitedEarly) markExited(exitedEarly.code);
    return { ok: true, sessionId };
  }

  /**
   * Keystrokes, including the control characters. Failures are not
   * reported: a write only fails once the shell is gone, and the exit
   * that caused it is already on its way to the same panel.
   */
  write(sessionId: string, data: string): void {
    void this.shells.write(sessionId, data).catch(() => undefined);
  }

  resize(sessionId: string, size: ShellSize): void {
    void this.shells.resize(sessionId, size).catch(() => undefined);
  }

  select(tabId: string, sessionId: string): void {
    this.store.dispatch({ type: "shell/selected", tabId, sessionId });
  }

  /** Drop the terminal from the strip and kill its shell tree. */
  async close(tabId: string, sessionId: string): Promise<void> {
    this.store.dispatch({ type: "shell/closed", tabId, sessionId });
    await this.shells.close(sessionId).catch(() => undefined);
  }
}
