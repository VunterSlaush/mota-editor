import { Plus, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ShellSession } from "../../core/entities/shellSession";
import { shellExitLabel } from "../../core/entities/shellSession";
import type { OpenShellRequest, OpenShellResult } from "../../core/usecases/shells";
import {
  forgetXterm,
  rememberXterm,
  restyleAll,
  xtermFor,
} from "../terminals/shellRegistry";
import { createXtermSession } from "../terminals/xtermSession";

interface Props {
  sessions: readonly ShellSession[];
  activeShellId?: string;
  /** A "!" line from the composer is waiting for a free prompt. */
  awaitingLine: boolean;
  /** Set by the drag handle on the panel's left edge. */
  width: number;
  fontSize: number;
  /** Changing the theme restyles every terminal already open. */
  theme: string;
  onOpen: (request: OpenShellRequest) => Promise<OpenShellResult>;
  onWrite: (sessionId: string, data: string) => void;
  onAcceptSuggestion: (sessionId: string) => void;
  onResize: (sessionId: string, size: { cols: number; rows: number }) => void;
  onSelect: (sessionId: string) => void;
  onClose: (sessionId: string) => void;
  onClosePanel: () => void;
}

/** Before the panel has been measured, every terminal starts here. */
const UNMEASURED = { cols: 80, rows: 24 };

/**
 * UI — the user's terminals, as a right-side section of the chat.
 *
 * Humble in the usual sense — every intent is one call out — but not
 * quite in the usual shape: the xterm instances live in a module-level
 * registry rather than in state, because a pty outlives this component
 * and its scrollback has to as well.
 */
export function TerminalPanel({
  sessions,
  activeShellId,
  awaitingLine,
  width,
  fontSize,
  theme,
  onOpen,
  onWrite,
  onAcceptSuggestion,
  onResize,
  onSelect,
  onClose,
  onClosePanel,
}: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const noticedExits = useRef(new Set<string>());
  const opening = useRef(false);

  const openTerminal = useCallback(async () => {
    // Guarded because StrictMode runs mount effects twice in development,
    // and a second pass would silently spawn a second shell.
    if (opening.current) return;
    opening.current = true;
    setProblem(null);

    let sessionId: string | null = null;
    const xterm = createXtermSession(
      {
        onData: (data) => {
          if (sessionId) onWrite(sessionId, data);
        },
        onAcceptSuggestion: () => {
          if (sessionId) onAcceptSuggestion(sessionId);
        },
      },
      fontSize,
    );
    // Attached and measured before the shell starts, so its first prompt
    // is drawn at the width it will keep.
    const host = hostRef.current;
    if (host) {
      host.replaceChildren();
      xterm.attach(host);
      xterm.fit();
    }

    const result = await onOpen({
      size: host ? xterm.size() : UNMEASURED,
      onOutput: (bytes) => xterm.write(bytes),
      onSuggest: (suffix) => xterm.showSuggestion(suffix),
    });
    opening.current = false;
    if (!result.ok) {
      xterm.dispose();
      setProblem(result.message);
      return;
    }
    sessionId = result.sessionId;
    rememberXterm(sessionId, xterm);
    xterm.focus();
  }, [fontSize, onOpen, onWrite, onAcceptSuggestion]);

  // The panel opens with a terminal ready; nobody wants to press "+"
  // before they can type.
  useEffect(() => {
    if (sessions.length === 0) void openTerminal();
    // Only on mount: later emptiness means the user closed the last one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A "!" line is parked because every terminal here is busy or dead.
  // Open one for it — the use case runs it as the shell comes up. Racing
  // the mount effect above is harmless: `openTerminal` refuses to start
  // a second shell while the first is still opening. Once per parked
  // line, though: a shell that cannot spawn leaves the line waiting, and
  // that must not become one spawn attempt per re-render.
  const askedForOne = useRef(false);
  useEffect(() => {
    if (!awaitingLine) {
      askedForOne.current = false;
      return;
    }
    if (askedForOne.current) return;
    askedForOne.current = true;
    void openTerminal();
  }, [awaitingLine, openTerminal]);

  // Show whichever terminal is selected, wherever it was last rendered.
  useEffect(() => {
    const host = hostRef.current;
    const xterm = activeShellId ? xtermFor(activeShellId) : undefined;
    if (!host || !xterm || !activeShellId) return;
    host.replaceChildren();
    xterm.attach(host);
    restyleAll(fontSize);
    if (xterm.fit()) onResize(activeShellId, xterm.size());
    xterm.focus();
  }, [activeShellId, fontSize, theme, onResize]);

  // The pty has to be told the new size, or programs keep drawing to the
  // old one — a resized panel with a wrapped prompt is the giveaway.
  useEffect(() => {
    const host = hostRef.current;
    if (!host || !activeShellId) return;
    const observer = new ResizeObserver(() => {
      const xterm = xtermFor(activeShellId);
      if (xterm?.fit()) onResize(activeShellId, xterm.size());
    });
    observer.observe(host);
    return () => observer.disconnect();
  }, [activeShellId, onResize]);

  // The shell said nothing on its way out, so the panel does.
  useEffect(() => {
    for (const session of sessions) {
      if (!session.exit || noticedExits.current.has(session.id)) continue;
      noticedExits.current.add(session.id);
      xtermFor(session.id)?.writeExitNotice(session.exit.code);
    }
  }, [sessions]);

  const closeTerminal = useCallback(
    (sessionId: string) => {
      forgetXterm(sessionId);
      noticedExits.current.delete(sessionId);
      onClose(sessionId);
    },
    [onClose],
  );

  return (
    <aside className="terminal-side" style={{ width }} aria-label="Terminal">
      <div className="terminal-side__header">
        <div className="terminal-side__tabs" role="tablist" aria-label="Terminals">
          {sessions.map((session) => (
            <TerminalTab
              key={session.id}
              session={session}
              active={session.id === activeShellId}
              onSelect={() => onSelect(session.id)}
              onClose={() => closeTerminal(session.id)}
            />
          ))}
        </div>
        <div className="terminal-side__actions">
          <button
            type="button"
            className="icon-button"
            aria-label="New terminal"
            title="New terminal"
            onClick={() => void openTerminal()}
          >
            <Plus />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Hide terminal"
            title="Hide terminal (Ctrl+`)"
            onClick={onClosePanel}
          >
            <X />
          </button>
        </div>
      </div>
      {problem && <p className="terminal-side__problem">{problem}</p>}
      <div className="terminal-side__body" ref={hostRef} />
    </aside>
  );
}

function TerminalTab({
  session,
  active,
  onSelect,
  onClose,
}: {
  session: ShellSession;
  active: boolean;
  onSelect: () => void;
  onClose: () => void;
}) {
  const exited = shellExitLabel(session);
  return (
    <span
      className={`terminal-tab ${active ? "terminal-tab--active" : ""} ${
        exited ? "terminal-tab--exited" : ""
      }`}
    >
      <button
        type="button"
        role="tab"
        aria-selected={active}
        className="terminal-tab__label"
        title={exited ? `${session.title} — ${exited}` : session.title}
        onClick={onSelect}
      >
        {session.title}
      </button>
      <button
        type="button"
        className="terminal-tab__close"
        aria-label={`Close ${session.title}`}
        onClick={onClose}
      >
        <X size={12} />
      </button>
    </span>
  );
}
