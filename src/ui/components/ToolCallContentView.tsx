import { FileText, Terminal as TerminalIcon } from "@phosphor-icons/react";
import { countChanges } from "../../core/entities/diff";
import type { ToolCallState } from "../../core/entities/message";
import { diffTexts } from "../../core/entities/textDiff";
import { fileName } from "../fileName";

export interface AgentDiff {
  readonly path: string;
  readonly oldText?: string;
  readonly newText: string;
}

interface Props {
  toolCall: ToolCallState;
  onOpenFile: (path: string) => void;
  onShowDiff: (diff: AgentDiff) => void;
}

/**
 * UI — what a tool call reported back: output text, file diffs (opened
 * in the shared DiffModal), terminals (placeholder until C4 lands), and
 * the files it touched. Shared between expanded tool rows and approval
 * cards, so "what is this tool doing" always looks the same.
 */
export function ToolCallContentView({ toolCall, onOpenFile, onShowDiff }: Props) {
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
                  oldText: item.oldText,
                  newText: item.newText,
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
          // biome-ignore lint/suspicious/noArrayIndexKey: content blocks are a positional list
          <span key={index} className="tool-content__terminal">
            <TerminalIcon size={13} /> terminal output (not yet mirrored here)
          </span>
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
