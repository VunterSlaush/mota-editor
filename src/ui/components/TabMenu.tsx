import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { MAX_TAB_LABEL_LENGTH } from "../../core/entities/project";
import { TAB_COLORS, type TabColorId } from "../../core/entities/tabColor";
import { type HostRect, tooltipPlacement } from "./tooltipPlacement";

interface Props {
  /** The tab's box, to place the panel against. */
  anchor: HostRect;
  /** The tab's own name, empty when it has none. */
  label: string;
  color: TabColorId | undefined;
  /** What the tab is called when it has no name of its own. */
  folderName: string;
  onRename: (label: string) => void;
  onRecolor: (color: TabColorId | undefined) => void;
  onClose: () => void;
}

/**
 * UI — a tab's name and grouping colour, on right-click.
 *
 * The half-typed name lives here and is committed once, on the way out.
 * Committing saves the workspace, and a save serialises the whole thing
 * to disk — so a field that dispatched per keystroke would be a file
 * write per character. Escape leaves without committing, which is only a
 * meaningful distinction because the commit is deferred.
 */
export function TabMenu({
  anchor,
  label,
  color,
  folderName,
  onRename,
  onRecolor,
  onClose,
}: Props) {
  const [draft, setDraft] = useState(label);
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLInputElement>(null);
  const abandoned = useRef(false);

  // The latest commit, reachable from an unmount that must not depend on
  // it: `onRename` is a fresh arrow on every parent render, so an effect
  // that listed it would tear down and re-run — committing — per render.
  const commit = useRef<() => void>(() => {});
  commit.current = () => {
    if (!abandoned.current && draft !== label) onRename(draft);
  };

  // Every way out of this panel commits, so no exit has to remember to.
  // Empty deps deliberately: the cleanup must run on unmount and at no
  // other time.
  useEffect(() => () => commit.current(), []);

  // Placed after it is drawn, because where it goes depends on how big it
  // turned out — the same measure-then-position the tooltip layer does.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!element) return;
    const { left, top } = tooltipPlacement(
      anchor,
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.visibility = "visible";
  }, [anchor]);

  // Right-click, type, Enter — with no click in between.
  useEffect(() => {
    field.current?.focus();
    field.current?.select();
  }, []);

  // A click anywhere else is done with the panel, and takes the name with
  // it: leaving the field commits, exactly as blurring it would.
  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!panel.current?.contains(event.target as Node)) onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    return () => document.removeEventListener("mousedown", onPointerDown);
  }, [onClose]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    // Gated to the field: an un-gated preventDefault would swallow Enter on
    // the swatch buttons too, closing the panel instead of activating them.
    if (event.key === "Enter" && event.target === field.current) {
      event.preventDefault();
      onClose();
    } else if (event.key === "Escape") {
      event.preventDefault();
      abandoned.current = true;
      onClose();
    }
  };

  return (
    <div
      className="tab-menu"
      ref={panel}
      role="dialog"
      aria-label="Tab name and colour"
      onKeyDown={onKeyDown}
    >
      <input
        ref={field}
        className="tab-menu__name"
        value={draft}
        placeholder={folderName}
        maxLength={MAX_TAB_LABEL_LENGTH}
        aria-label="Tab name"
        onChange={(event) => setDraft(event.target.value)}
      />
      <div className="tab-menu__colors">
        <button
          type="button"
          className={`tab-menu__color tab-menu__color--none ${
            color === undefined ? "tab-menu__color--on" : ""
          }`}
          aria-label="No colour"
          aria-pressed={color === undefined}
          onClick={() => onRecolor(undefined)}
        />
        {TAB_COLORS.map((swatch) => (
          <button
            key={swatch.id}
            type="button"
            data-color={swatch.id}
            className={`tab-menu__color ${
              color === swatch.id ? "tab-menu__color--on" : ""
            }`}
            aria-label={swatch.label}
            aria-pressed={color === swatch.id}
            onClick={() => onRecolor(swatch.id)}
          />
        ))}
      </div>
    </div>
  );
}
