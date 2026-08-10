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
  /** A closing line the shell itself never got to print. */
  writeExitNotice(code: number | null): void;
  dispose(): void;
}

export function createXtermSession(
  onData: (data: string) => void,
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
  term.onData(onData);

  // xterm needs a live element to measure; it is moved between hosts as
  // the panel opens and closes, and re-opening must not lose scrollback.
  const holder = document.createElement("div");
  holder.className = "terminal-view__surface";
  term.open(holder);

  let lastSize: ShellSize = { cols: term.cols, rows: term.rows };

  return {
    attach(host) {
      if (holder.parentElement === host) return;
      host.appendChild(holder);
      // Re-inserted after the panel was closed: the rows are still in the
      // buffer but the renderer has not been asked to draw them since.
      term.refresh(0, term.rows - 1);
    },
    write(bytes) {
      term.write(bytes);
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
    writeExitNotice(code) {
      const detail = code === null ? "" : ` with code ${code}`;
      term.write(`\r\n\x1b[2m[process exited${detail}]\x1b[0m\r\n`);
    },
    dispose() {
      term.dispose();
      holder.remove();
    },
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
