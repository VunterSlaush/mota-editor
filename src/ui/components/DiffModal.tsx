import { X } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import {
  countChanges,
  type DiffHunk,
  type DiffLine,
  parseUnifiedDiff,
  toSideBySide,
} from "../../core/entities/diff";
import { diffTexts } from "../../core/entities/textDiff";
import type { AgentEdit } from "../../core/entities/tool";
import { fileName } from "../fileName";
import { useResizableModal } from "../useResizableModal";

/** Where the diff comes from: git (loaded async) or the agent's own
 *  reported edit (full old/new text, diffed locally). */
export type DiffSource =
  | {
      readonly kind: "git";
      /** True when showing the index side rather than the working tree. */
      readonly staged: boolean;
      /** Resolves with the unified diff, or rejects with git's message. */
      readonly load: () => Promise<{ ok: boolean; message: string }>;
    }
  | {
      readonly kind: "agent";
      /** Every edit reported for the file, oldest first — a tool row
       *  passes one, the Changes panel the session's whole run of them. */
      readonly edits: readonly AgentEdit[];
    };

interface Props {
  path: string;
  source: DiffSource;
  onClose: () => void;
}

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; text: string };

/** A resized modal never goes below this; the CSS caps handle the top end. */
const MINIMUM = { width: 480, height: 240 };

/**
 * UI — one file's change, old on the left and new on the right, in the
 * red/green everyone already reads. Escape or a click outside closes it.
 */
export function DiffModal({ path, source, onClose }: Props) {
  const [result, setResult] = useState<Load>({ state: "loading" });
  const { ref, size, startResize, resetSize } = useResizableModal(MINIMUM, "top");

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const staged = source.kind === "git" && source.staged;
  useEffect(() => {
    if (source.kind !== "git") return;
    let cancelled = false;
    source.load().then((r) => {
      if (cancelled) return;
      setResult(
        r.ok
          ? { state: "loaded", text: r.message }
          : { state: "failed", message: r.message },
      );
    });
    return () => {
      cancelled = true;
    };
    // The loader is a fresh closure per render; the file identifies the work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, staged]);

  const edits = source.kind === "agent" ? source.edits : undefined;
  const hunks = useMemo(() => {
    if (edits) return agentHunks(edits);
    return result.state === "loaded" ? parseUnifiedDiff(result.text) : [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [edits, result]);
  const loading = source.kind === "git" && result.state === "loading";
  const failed = source.kind === "git" && result.state === "failed" ? result : null;
  const empty = !loading && !failed && hunks.length === 0;
  const { added, removed } = countChanges(hunks);

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        ref={ref}
        className="diff-modal"
        role="dialog"
        aria-modal="true"
        aria-label={`Diff for ${path}`}
        style={size ?? undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="diff-modal__header">
          <span className="diff-modal__name">{fileName(path)}</span>
          <span className="diff-modal__path">{path}</span>
          <span className="diff-modal__badge">
            {source.kind === "agent" ? "agent edit" : staged ? "staged" : "not staged"}
          </span>
          {hunks.length > 0 && (
            <span className="diff-modal__stat">
              <span className="diff-modal__stat--add">+{added}</span>
              <span className="diff-modal__stat--remove">−{removed}</span>
            </span>
          )}
          <button
            type="button"
            className="diff-modal__close"
            aria-label="Close diff"
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>

        <div className="diff-modal__body">
          {loading && <p className="diff-modal__note">Loading diff…</p>}
          {failed && (
            <p className="diff-modal__note diff-modal__note--error">{failed.message}</p>
          )}
          {empty && (
            <p className="diff-modal__note">
              No textual changes — the file may be binary, or only its mode changed.
            </p>
          )}
          {hunks.map((hunk, hunkIndex) => (
            <section
              // biome-ignore lint/suspicious/noArrayIndexKey: two hunks can share a header; order is the identity
              key={hunkIndex}
              className="diff-hunk"
            >
              <div className="diff-hunk__header">{hunk.header}</div>
              {toSideBySide(hunk).map((row, index) => (
                <div
                  // biome-ignore lint/suspicious/noArrayIndexKey: rows are a positional pairing within one hunk
                  key={index}
                  className="diff-row"
                >
                  <Side line={row.left} side="old" />
                  <Side line={row.right} side="new" />
                </div>
              ))}
            </section>
          ))}
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only affordance; the modal is fully usable at its default size */}
        <div
          className="diff-modal__resize"
          title="Drag to resize · double-click to reset"
          onPointerDown={startResize}
          onDoubleClick={resetSize}
        />
      </div>
    </div>
  );
}

/**
 * Every reported edit of a file, diffed in order into one list of hunks.
 * Each edit is its own text pair (usually one hunk of a patch), so the
 * line numbers in the `@@` headers are local to it — the ordinal says
 * which edit a hunk belongs to, so a file changed five times doesn't
 * read as five copies of the same header.
 */
function agentHunks(edits: readonly AgentEdit[]): readonly DiffHunk[] {
  return edits.flatMap((edit, index) => {
    const hunks = diffTexts(edit.oldText ?? "", edit.newText);
    if (edits.length === 1) return hunks;
    return hunks.map((hunk) => ({
      ...hunk,
      header: `Edit ${index + 1} of ${edits.length} · ${hunk.header}`,
    }));
  });
}

/** One column of a row. An absent line is the blank half of a change. */
function Side({ line, side }: { line?: DiffLine; side: "old" | "new" }) {
  if (!line) return <div className="diff-cell diff-cell--empty" />;
  // The old column shows removals, the new one additions; context shows
  // on both. Anything else would be the same line coloured twice.
  const kind = line.kind === "context" ? "context" : side === "old" ? "remove" : "add";
  const number = side === "old" ? line.oldNo : line.newNo;
  return (
    <div className={`diff-cell diff-cell--${kind}`}>
      <span className="diff-cell__no">{number ?? ""}</span>
      <span className="diff-cell__sign">
        {kind === "add" ? "+" : kind === "remove" ? "−" : " "}
      </span>
      <span className="diff-cell__text">{line.text}</span>
    </div>
  );
}
