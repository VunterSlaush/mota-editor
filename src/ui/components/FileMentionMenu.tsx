import { useEffect, useRef } from "react";
import { fileName } from "../fileName";

interface Props {
  files: readonly string[];
  selectedIndex: number;
  onPick: (path: string) => void;
}

/**
 * UI — the project-file list shown above the composer while typing "@".
 * Wears the slash palette's clothes: the same rows, the same keys, the
 * same place on screen, because it is the same gesture aimed at files.
 */
export function FileMentionMenu({ files, selectedIndex, onPick }: Props) {
  const selectedRef = useRef<HTMLDivElement>(null);
  // The list scrolls (max-height); arrowing must keep the selection on
  // screen or the keys appear to do nothing.
  useEffect(() => {
    selectedRef.current?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  if (files.length === 0) return null;
  return (
    <div className="command-palette" role="listbox" aria-label="Project files">
      {files.map((path, index) => (
        <div
          key={path}
          ref={index === selectedIndex ? selectedRef : undefined}
          role="option"
          aria-selected={index === selectedIndex}
          className={`command-palette__item ${
            index === selectedIndex ? "command-palette__item--selected" : ""
          }`}
          onMouseDown={(e) => {
            e.preventDefault(); // keep focus in the textarea
            onPick(path);
          }}
        >
          <span className="command-palette__name">{fileName(path)}</span>
          <span className="command-palette__description">{path}</span>
        </div>
      ))}
    </div>
  );
}
