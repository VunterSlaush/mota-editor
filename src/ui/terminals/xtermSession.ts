import { FitAddon } from "@xterm/addon-fit";
import { Terminal } from "@xterm/xterm";
import type { ShellSize } from "../../core/ports/shellPort";
import "@xterm/xterm/css/xterm.css";

/**
 * UI — one xterm.js instance and the DOM plumbing around it.
 *
 * Frameworks-and-drivers code: xterm is a renderer, and this is the only
 * place that knows it exists. What it renders arrives as raw bytes from
 * the shell port; what the user types leaves as raw bytes. Nothing here
 * decides anything.
 */
export interface XtermSession {
  /** Move the terminal into `host`, keeping its scrollback. */
  attach(host: HTMLElement): void;
  write(bytes: Uint8Array): void;
  /** Re-measure against the host; true when the size actually changed. */
  fit(): boolean;
  readonly size: () => ShellSize;
  focus(): void;
  /** Re-read the app's palette and font size, after either changes. */
  restyle(fontSize: number): void;
  /** Draw the greyed-out completion after the cursor; "" clears it. */
  showSuggestion(suffix: string): void;
  /** A closing line the shell itself never got to print. */
  writeExitNotice(code: number | null): void;
  dispose(): void;
}

/** What a terminal reports back to the app. */
export interface XtermHandlers {
  readonly onData: (data: string) => void;
  /** The user pressed the accept key while a suggestion was showing. */
  readonly onAcceptSuggestion: () => void;
}

export function createXtermSession(
  handlers: XtermHandlers,
  fontSize: number,
): XtermSession {
  const term = new Terminal({
    fontSize,
    fontFamily: 'ui-monospace, "Cascadia Mono", "SF Mono", Consolas, monospace',
    // Deep enough to scroll back through a build, shallow enough that a
    // runaway log does not become the app's memory profile.
    scrollback: 5000,
    cursorBlink: true,
    allowProposedApi: true,
    theme: currentTheme(),
  });
  const fitAddon = new FitAddon();
  term.loadAddon(fitAddon);
  term.onData(handlers.onData);

  // xterm needs a live element to measure; it is moved between hosts as
  // the panel opens and closes, and re-opening must not lose scrollback.
  const holder = document.createElement("div");
  holder.className = "terminal-view__surface";
  term.open(holder);

  let lastSize: ShellSize = { cols: term.cols, rows: term.rows };
  const ghost = createGhost(term);

  // Right arrow accepts, the way every shell that does this binds it —
  // and so does Tab, because a greyed-out completion under the cursor is
  // what a person is reaching for when they press it. Left to the shell,
  // Tab ran its own completion and inserted something else entirely.
  //
  // Both are safe to take: a suggestion only exists when the cursor is at
  // the end of a line we have followed exactly, so Right arrow would move
  // into nothing and Tab would be completing an argument we can see is
  // not there. With no suggestion showing they fall through untouched,
  // and the shell's completion is exactly as it was.
  const ACCEPT_KEYS = ["ArrowRight", "Tab"];
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !ACCEPT_KEYS.includes(e.key)) return true;
    if (e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return true;
    if (!ghost.showing()) return true;
    // Tab is focus traversal to the browser; nothing else stops it from
    // walking off the terminal once xterm has been told to ignore the key.
    e.preventDefault();
    handlers.onAcceptSuggestion();
    return false;
  });

  return {
    attach(host) {
      if (holder.parentElement === host) return;
      host.appendChild(holder);
      // Re-inserted after the panel was closed: the rows are still in the
      // buffer but the renderer has not been asked to draw them since.
      term.refresh(0, term.rows - 1);
    },
    write(bytes) {
      // Re-anchored rather than cleared: almost every write is the shell
      // echoing the keystroke that produced the suggestion in the first
      // place, and clearing on echo would erase it the instant it
      // appeared. The cursor has moved, so it is redrawn once xterm has
      // finished applying the bytes.
      term.write(bytes, ghost.reanchor);
    },
    fit() {
      // A panel mid-layout measures as zero and would ask the pty for an
      // impossible size; skip until the browser has settled.
      if (holder.clientWidth === 0 || holder.clientHeight === 0) return false;
      fitAddon.fit();
      const changed = term.cols !== lastSize.cols || term.rows !== lastSize.rows;
      lastSize = { cols: term.cols, rows: term.rows };
      return changed;
    },
    size: () => lastSize,
    focus() {
      term.focus();
    },
    restyle(nextFontSize) {
      term.options.theme = currentTheme();
      term.options.fontSize = nextFontSize;
    },
    showSuggestion(suffix) {
      ghost.show(suffix);
    },
    writeExitNotice(code) {
      const detail = code === null ? "" : ` with code ${code}`;
      term.write(`\r\n\x1b[2m[process exited${detail}]\x1b[0m\r\n`);
    },
    dispose() {
      ghost.clear();
      term.dispose();
      holder.remove();
    },
  };
}

/**
 * The greyed-out completion, drawn as an xterm decoration anchored to
 * the cursor's line — the same mechanism VS Code uses for gutter marks.
 * A decoration is display only: nothing here reaches the pty, so a stale
 * suggestion can never become text the shell sees.
 */
function createGhost(term: Terminal) {
  let marker: ReturnType<Terminal["registerMarker"]> | undefined;
  let text = "";

  /** Take the decoration off the screen, keeping what it said. */
  const erase = () => {
    marker?.dispose(); // disposes the decoration hanging off it
    marker = undefined;
  };

  /** Draw the current text at wherever the cursor is now. */
  const draw = () => {
    erase();
    if (!text) return;
    const cursor = term.buffer.active;
    const room = term.cols - cursor.cursorX;
    if (room <= 0) return; // nothing left on this row to draw into
    const next = term.registerMarker(0);
    if (!next) return;
    const decoration = term.registerDecoration({
      marker: next,
      x: cursor.cursorX,
      width: Math.min(text.length, room),
      layer: "top",
    });
    if (!decoration) {
      next.dispose();
      return;
    }
    marker = next;
    const shown = text.slice(0, room);
    // `classList`, not `className`: xterm puts its own positioning
    // classes on this element and overwriting them hides it.
    decoration.onRender((element) => {
      element.classList.add("terminal-ghost");
      element.textContent = shown;
    });
  };

  return {
    showing: () => text !== "",
    clear() {
      text = "";
      erase();
    },
    show(suffix: string) {
      if (suffix === text) return;
      text = suffix;
      draw();
    },
    reanchor: draw,
  };
}

/**
 * The terminal's palette, read from the theme the rest of the app is
 * already wearing. The sixteen ANSI colours are not in that palette —
 * they are the terminal's own vocabulary — so they come from a fixed set
 * chosen to sit on either a dark or a light background.
 */
function currentTheme() {
  const style = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string) =>
    style.getPropertyValue(name).trim() || fallback;
  return {
    background: read("--bg", "#14161a"),
    foreground: read("--text", "#e6e8eb"),
    cursor: read("--accent", "#4f8cff"),
    cursorAccent: read("--bg", "#14161a"),
    selectionBackground: `${read("--accent", "#4f8cff")}44`,
    black: "#3b4048",
    red: "#e06c75",
    green: "#98c379",
    yellow: "#d19a66",
    blue: "#61afef",
    magenta: "#c678dd",
    cyan: "#56b6c2",
    white: "#abb2bf",
    brightBlack: "#5c6370",
    brightRed: "#ff7b86",
    brightGreen: "#a9d98a",
    brightYellow: "#e5c07b",
    brightBlue: "#7cc0ff",
    brightMagenta: "#d99ae8",
    brightCyan: "#66d3df",
    brightWhite: "#e6e8eb",
  };
}
