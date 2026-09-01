import { ArrowSquareOut, FolderOpen, SelectionPlus } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef } from "react";
import { CAN_OPEN_WITH, fileManagerName } from "../fileActions";
import { fileName } from "../fileName";
import { contextMenuPlacement, type Point } from "./contextMenuPlacement";

interface Props {
  /** Project-relative, as the file tree lists it. */
  path: string;
  /** Where the secondary click landed, in viewport coordinates. */
  cursor: Point;
  /** The row's own default action — the in-app viewer for markdown, the
   *  OS for everything else — so "Open" and a left click agree. */
  onOpen: () => void;
  onOpenWith: () => void;
  onReveal: () => void;
  onClose: () => void;
}

/**
 * UI — a file row's secondary-click menu: open it, open it with something
 * else, or go find it on disk.
 *
 * "Open with" is left out where the desktop has no chooser to hand the
 * file to; an item that always fails is worse than one that isn't there.
 *
 * Every item closes the menu on its way out, so no handler has to
 * remember to — and a click anywhere else, or Escape, closes it too.
 */
export function FileContextMenu({
  path,
  cursor,
  onOpen,
  onOpenWith,
  onReveal,
  onClose,
}: Props) {
  const menu = useRef<HTMLDivElement>(null);

  // Placed after it is drawn, because where it goes depends on how big it
  // turned out — the same measure-then-position the tab menu does.
  useLayoutEffect(() => {
    const element = menu.current;
    if (!element) return;
    const { left, top } = contextMenuPlacement(
      cursor,
      { width: element.offsetWidth, height: element.offsetHeight },
      { width: window.innerWidth, height: window.innerHeight },
    );
    element.style.left = `${left}px`;
    element.style.top = `${top}px`;
    element.style.visibility = "visible";
  }, [cursor]);

  useEffect(() => {
    const onPointerDown = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    // Placed once against a row that scrolls: the menu is positioned in
    // the viewport, so a scrolled list would slide out from under it and
    // leave it pointing at whatever moved into that spot. Captured,
    // because the scrolling element is the panel, not the document.
    window.addEventListener("scroll", onClose, true);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("scroll", onClose, true);
    };
  }, [onClose]);

  const choose = (act: () => void) => () => {
    onClose();
    act();
  };

  return (
    <div
      className="context-menu"
      ref={menu}
      role="menu"
      aria-label={`Actions for ${fileName(path)}`}
    >
      <button
        type="button"
        role="menuitem"
        className="context-menu__item"
        onClick={choose(onOpen)}
      >
        <ArrowSquareOut size={14} /> Open
      </button>
      {CAN_OPEN_WITH && (
        <button
          type="button"
          role="menuitem"
          className="context-menu__item"
          onClick={choose(onOpenWith)}
        >
          <SelectionPlus size={14} /> Open with…
        </button>
      )}
      <button
        type="button"
        role="menuitem"
        className="context-menu__item"
        onClick={choose(onReveal)}
      >
        <FolderOpen size={14} /> Show in {fileManagerName()}
      </button>
    </div>
  );
}
