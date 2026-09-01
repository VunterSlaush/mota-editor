import { ArrowSquareOut, X } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { fileName } from "../fileName";
import type { MarkdownFile } from "../readMarkdownFile";
import { useResizableModal } from "../useResizableModal";
import { Markdown } from "./MarkdownLite";

/** A resized modal never goes below this; the CSS caps handle the top end. */
const MINIMUM = { width: 360, height: 240 };

type Load =
  | { state: "loading" }
  | { state: "failed"; message: string }
  | { state: "loaded"; text: string };

interface Props {
  /** Project-relative, as the file tree lists it. */
  path: string;
  /** Resolves with the file's text, or with why it could not be read. */
  load: () => Promise<MarkdownFile>;
  /** Hands the same file to the OS — the escape hatch to a real editor. */
  onOpenExternally: () => void;
  onClose: () => void;
}

/**
 * UI — one of the project's markdown files, rendered. The app already
 * carries a markdown renderer for agent output, so a README is readable
 * here without leaving for another window (ADR-0019).
 *
 * Read-only on purpose: this shows a file, it does not edit one. The
 * header keeps the old behaviour one click away for when the answer is
 * "actually I want to change this".
 *
 * Drag the bottom-right grip to resize; Escape or a click outside closes.
 */
export function MarkdownFileModal({ path, load, onOpenExternally, onClose }: Props) {
  const [result, setResult] = useState<Load>({ state: "loading" });
  const { ref, size, startResize, resetSize } = useResizableModal(MINIMUM, "center");

  useEffect(() => {
    let cancelled = false;
    setResult({ state: "loading" });
    load().then((file) => {
      if (cancelled) return;
      setResult(
        file.ok
          ? { state: "loaded", text: file.text }
          : { state: "failed", message: file.message },
      );
    });
    return () => {
      cancelled = true;
    };
    // The loader is a fresh closure per render; the file identifies the work.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-overlay modal-overlay--center" onMouseDown={onClose}>
      <div
        ref={ref}
        className="markdown-modal"
        role="dialog"
        aria-modal="true"
        aria-label={path}
        style={size ?? undefined}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <header className="markdown-modal__header">
          <span className="markdown-modal__name">{fileName(path)}</span>
          <span className="markdown-modal__path">{path}</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Open in the default app"
            title="Open in the default app"
            onClick={onOpenExternally}
          >
            <ArrowSquareOut />
          </button>
          <button
            type="button"
            className="icon-button"
            aria-label="Close file"
            onClick={onClose}
          >
            <X />
          </button>
        </header>

        <div className="markdown-modal__body">
          {result.state === "loading" && <p className="markdown-modal__note">Loading…</p>}
          {result.state === "failed" && (
            <p className="markdown-modal__note markdown-modal__note--error">
              {result.message}
            </p>
          )}
          {result.state === "loaded" &&
            (result.text.trim() === "" ? (
              <p className="markdown-modal__note">This file is empty.</p>
            ) : (
              <Markdown text={result.text} />
            ))}
        </div>
        {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only affordance; the modal is fully usable at its default size */}
        <div
          className="markdown-modal__resize"
          title="Drag to resize · double-click to reset"
          onPointerDown={startResize}
          onDoubleClick={resetSize}
        />
      </div>
    </div>
  );
}
