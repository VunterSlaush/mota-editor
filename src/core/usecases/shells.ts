import type { InputLine } from "../entities/inputLine";
import { EMPTY_LINE, typeInto } from "../entities/inputLine";
import type { CommandHistory } from "../entities/shellHistory";
import { historyFrom, remember, suggestionSuffix } from "../entities/shellHistory";
import { nextShellTitle } from "../entities/shellSession";
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
    return { ok: true, sessionId };
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
    this.warmHistory();
    tracked.suggest(this.suffixFor(sessionId));
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
