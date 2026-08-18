import { FileText, Terminal as TerminalIcon } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { countChanges } from "../../core/entities/diff";
import type { ToolCallState } from "../../core/entities/message";
import { diffTexts } from "../../core/entities/textDiff";
import type { AgentEdit } from "../../core/entities/tool";
import { fileName } from "../fileName";

/** What the diff modal shows for a file the agent changed: one edit
 *  from a tool row, or every edit of the session from the Changes panel. */
export interface AgentDiff {
  readonly path: string;
  readonly edits: readonly AgentEdit[];
}

/** Reads a client-owned terminal's captured output (null = gone). */
export type ReadTerminal = (
  terminalId: string,
) => Promise<{ output: string; truncated: boolean; exited: boolean } | null>;

interface Props {
  toolCall: ToolCallState;
  onOpenFile: (path: string) => void;
  onShowDiff: (diff: AgentDiff) => void;
  onReadTerminal: ReadTerminal;
}

/** Live output keeps arriving while the command runs; poll at this pace. */
const TERMINAL_POLL_MS = 1000;

/**
 * Output of one agent-run terminal, polled while the command is alive.
 * The backend keeps the buffer even after the command exits, so a
 * settled card still shows what happened.
 */
function TerminalView({
  terminalId,
  onReadTerminal,
}: {
  terminalId: string;
  onReadTerminal: ReadTerminal;
}) {
  const [state, setState] = useState<{
    output: string;
    truncated: boolean;
    exited: boolean;
  } | null>(null);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      const read = await onReadTerminal(terminalId).catch(() => null);
      if (cancelled) return;
      if (!read) {
        setGone(true);
        return;
      }
      setState(read);
      if (!read.exited) timer = setTimeout(poll, TERMINAL_POLL_MS);
    };
    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [terminalId, onReadTerminal]);

  if (gone && !state) {
    return (
      <span className="tool-content__terminal">
        <TerminalIcon size={13} /> terminal output no longer available
      </span>
    );
  }
  return (
    <div className="tool-content__terminal-view">
      <span className="tool-content__terminal">
        <TerminalIcon size={13} />
        {state?.exited ? "command finished" : "running…"}
        {state?.truncated ? " · output truncated to the tail" : ""}
      </span>
      <pre className="tool-content__text">{state?.output || "(no output yet)"}</pre>
    </div>
  );
}

/**
 * UI — what a tool call reported back: output text, file diffs (opened
 * in the shared DiffModal), terminals (placeholder until C4 lands), and
 * the files it touched. Shared between expanded tool rows and approval
 * cards, so "what is this tool doing" always looks the same.
 */
export function ToolCallContentView({
  toolCall,
  onOpenFile,
  onShowDiff,
  onReadTerminal,
}: Props) {
  return (
    <div className="tool-content">
      {toolCall.content.map((item, index) => {
        if (item.type === "text") {
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: content blocks are a positional list
            <pre key={index} className="tool-content__text">
              {item.text}
            </pre>
          );
        }
        if (item.type === "diff") {
          const { added, removed } = countChanges(
            diffTexts(item.oldText ?? "", item.newText),
          );
          return (
            <button
              // biome-ignore lint/suspicious/noArrayIndexKey: content blocks are a positional list
              key={index}
              type="button"
              className="tool-content__diff"
              onClick={() =>
                onShowDiff({
                  path: item.path,
                  edits: [{ oldText: item.oldText, newText: item.newText }],
                })
              }
            >
              <FileText size={13} />
              <span className="tool-content__diff-name">{fileName(item.path)}</span>
              <span className="tool-content__stat--add">+{added}</span>
              <span className="tool-content__stat--remove">−{removed}</span>
              <span className="tool-content__diff-hint">View diff</span>
            </button>
          );
        }
        return (
          <TerminalView
            key={item.terminalId}
            terminalId={item.terminalId}
            onReadTerminal={onReadTerminal}
          />
        );
      })}
      {toolCall.locations.length > 0 && (
        <div className="tool-content__locations">
          {toolCall.locations.map((location) => (
            <button
              key={`${location.path}:${location.line ?? ""}`}
              type="button"
              className="tool-content__location"
              title={location.path}
              onClick={() => onOpenFile(location.path)}
            >
              {fileName(location.path)}
              {location.line !== undefined ? `:${location.line}` : ""}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
