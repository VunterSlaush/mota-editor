import type { InputLine } from "../entities/inputLine";
import { EMPTY_LINE, typeInto } from "../entities/inputLine";
import type { CommandHistory } from "../entities/shellHistory";
import { historyFrom, remember, suggestionSuffix } from "../entities/shellHistory";
import { shellKeystrokes } from "../entities/shellLine";
import { idleShell, nextShellTitle, shellRunningAfter } from "../entities/shellSession";
import type { ShellHistorySource } from "../ports/shellHistorySource";
import type { ShellPort, ShellSize } from "../ports/shellPort";
import { tabById } from "../state/appState";
import type { Store } from "../state/store";

/**
 * What the view supplies when it asks for a terminal: how big it is, and
 * where the bytes and the suggestion should land. Both are callbacks
 * rather than state on purpose — routing a build log, or a suggestion
 * that changes on every keystroke, through the reducer would re-render
 * the whole app continuously.
 */
export interface OpenShellRequest {
  readonly size: ShellSize;
  readonly onOutput: (bytes: Uint8Array) => void;
  /** The greyed-out completion, or "" for none. */
  readonly onSuggest: (suffix: string) => void;
}

export type OpenShellResult =
  | { readonly ok: true; readonly sessionId: string }
  | { readonly ok: false; readonly message: string };

/** What one open terminal needs remembered between keystrokes. */
interface Tracked {
  readonly line: InputLine;
  readonly suggest: (suffix: string) => void;
}

/**
 * Use case — the user's terminals: open one in the project's folder,
 * carry keystrokes to it, suggest what they are about to type, and make
 * sure the shell dies when it should.
 */
export class Shells {
  private readonly tracked = new Map<string, Tracked>();
  private history: CommandHistory = [];
  private loading: Promise<void> | null = null;

  constructor(
    private readonly store: Store,
    private readonly shells: ShellPort,
    private readonly pastCommands: ShellHistorySource,
  ) {}

  async open(tabId: string, request: OpenShellRequest): Promise<OpenShellResult> {
    const state = this.store.getState();
    const tab = tabById(state, tabId);
    if (!tab) return { ok: false, message: "Unknown tab." };
    const title = nextShellTitle(tab.shells);
    this.warmHistory();

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

    this.tracked.set(sessionId, { line: EMPTY_LINE, suggest: request.onSuggest });
    this.store.dispatch({
      type: "shell/opened",
      tabId,
      session: { id: sessionId, title },
    });
    if (exitedEarly) markExited(exitedEarly.code);
    // A shell that was already dead is no place to run the waiting line;
    // it stays parked for a terminal that lives.
    else this.runParkedLine(tabId, sessionId);
    return { ok: true, sessionId };
  }

  /**
   * Run a command the user typed at the prompt, not in the terminal —
   * the composer's "!". It goes in as keystrokes, so the shell echoes
   * it, remembers it in its own history, and reports it running exactly
   * as if it had been typed there.
   *
   * A terminal that is busy is not a terminal to type into (see
   * `idleShell`), so with nothing free the line is parked for the next
   * one to open. Whoever asked for this is expected to show the terminal
   * panel: a command that runs where nobody is looking is a command
   * whose output is lost.
   */
  runLine(tabId: string, command: string): void {
    const tab = tabById(this.store.getState(), tabId);
    if (!tab || command === "") return;
    const target = idleShell(tab.shells, tab.activeShellId);
    if (!target) {
      this.store.dispatch({ type: "shell/lineParked", tabId, line: command });
      return;
    }
    // Bring it forward: the output is the whole point of running this.
    this.store.dispatch({ type: "shell/selected", tabId, sessionId: target.id });
    this.write(target.id, shellKeystrokes(command));
  }

  /**
   * The parked "!" line, now that this project has a terminal again.
   *
   * Typed ahead of the shell's first prompt on purpose: a pty buffers
   * what arrives while the shell is still starting, so the command runs
   * once it is ready — the same thing that happens to anyone who types
   * faster than their shell starts.
   */
  private runParkedLine(tabId: string, sessionId: string): void {
    const parked = tabById(this.store.getState(), tabId)?.pendingShellLine;
    if (!parked) return;
    this.store.dispatch({ type: "shell/lineRan", tabId });
    this.write(sessionId, shellKeystrokes(parked));
  }

  /**
   * Keystrokes, including the control characters.
   *
   * They pass through the line model on the way, which is the only
   * reason we know what the user is typing — nothing asks the shell.
   * Failures are not reported: a write only fails once the shell is
   * gone, and the exit that caused it is already on its way to the same
   * panel.
   */
  write(sessionId: string, data: string): void {
    this.track(sessionId, data);
    void this.shells.write(sessionId, data).catch(() => undefined);
  }

  /**
   * Type the rest of the suggested command. Sent as keystrokes rather
   * than applied to the model directly, so the shell's line editor and
   * ours end up believing the same thing.
   */
  acceptSuggestion(sessionId: string): void {
    const suffix = this.suffixFor(sessionId);
    if (suffix) this.write(sessionId, suffix);
  }

  resize(sessionId: string, size: ShellSize): void {
    void this.shells.resize(sessionId, size).catch(() => undefined);
  }

  select(tabId: string, sessionId: string): void {
    this.store.dispatch({ type: "shell/selected", tabId, sessionId });
  }

  /** Drop the terminal from the strip and kill its shell tree. */
  async close(tabId: string, sessionId: string): Promise<void> {
    this.tracked.delete(sessionId);
    this.store.dispatch({ type: "shell/closed", tabId, sessionId });
    await this.shells.close(sessionId).catch(() => undefined);
  }

  /** Advance the line model, learn from anything finished, re-suggest. */
  private track(sessionId: string, data: string): void {
    const tracked = this.tracked.get(sessionId);
    if (!tracked) return;
    const line = typeInto(tracked.line, data);
    this.tracked.set(sessionId, { ...tracked, line });
    for (const command of line.submitted) {
      this.history = remember(this.history, command);
    }
    this.reportRunning(sessionId, data, line);
    this.warmHistory();
    tracked.suggest(this.suffixFor(sessionId));
  }

  /**
   * Tell the store when a command takes the shell or hands it back, so
   * the terminal button can say so from anywhere in the app. Only on a
   * change: a keystroke is not news, and every one of them dispatching
   * would re-render the app for the length of a typed command.
   */
  private reportRunning(sessionId: string, data: string, line: InputLine): void {
    const state = this.store.getState();
    const tab = state.tabs.find((t) => t.shells.some((s) => s.id === sessionId));
    const session = tab?.shells.find((s) => s.id === sessionId);
    if (!tab || !session || session.exit) return;
    const running = shellRunningAfter(session.running === true, data, line);
    if (running === (session.running === true)) return;
    this.store.dispatch({
      type: "shell/running",
      tabId: tab.project.id,
      sessionId,
      running,
    });
  }

  private suffixFor(sessionId: string): string {
    if (!this.suggestionsWanted()) return "";
    const tracked = this.tracked.get(sessionId);
    return tracked ? suggestionSuffix(this.history, tracked.line.text) : "";
  }

  private suggestionsWanted(): boolean {
    return this.store.getState().settings.terminalSuggestions;
  }

  /**
   * Read the history file, unless the user has turned suggestions off —
   * then we have no business opening it at all.
   */
  private warmHistory(): void {
    if (this.suggestionsWanted()) void this.loadHistory();
  }

  /**
   * Seed from the shell's own history, once per app run. Suggestions
   * would otherwise be useless until the user had retyped enough for us
   * to have watched — and the shell has been keeping this list for
   * years.
   */
  private loadHistory(): Promise<void> {
    this.loading ??= this.pastCommands
      .recent()
      .then((lines) => {
        // Reading the file races with the user typing, so anything
        // learned meanwhile is folded on top rather than dropped. The
        // window is the sub-second before the first prompt appears, so
        // this is about not losing a command, not about ranking.
        const live = this.history;
        this.history = live.reduce(
          (all, entry) => remember(all, entry.line),
          historyFrom(lines),
        );
      })
      .catch(() => undefined);
    return this.loading;
  }
}
