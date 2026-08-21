import { ArrowClockwise, CaretDown, CaretRight } from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import type { FileRow } from "../../core/entities/fileTree";
import { buildFileTree, visibleRows } from "../../core/entities/fileTree";

interface Props {
  /** Every file in the project, flat. Stable across renders, or the
   *  effect below would refetch forever. */
  loadProjectFiles: () => Promise<string[]>;
  /** Hands the file to the OS; resolves to why it could not be opened. */
  onOpenFile: (path: string) => Promise<string | null>;
}

/** How far one level of nesting shifts a row, in pixels. */
const INDENT = 12;

/**
 * UI — the project's own files, as a tree.
 *
 * Clicking a file hands it to the operating system, which opens it in
 * whatever the user has that kind of file associated with. That is the
 * whole feature: this app drives agents, and pretending to be an editor
 * would mean carrying one.
 *
 * Folders start closed. Opening one is the only state the panel keeps, and
 * it is deliberately not kept anywhere else — switching tabs and coming
 * back collapses the tree, exactly as the Changes panel forgets which of
 * its sections were open.
 */
export function FilesPanel({ loadProjectFiles, onOpenFile }: Props) {
  const [paths, setPaths] = useState<readonly string[] | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadProjectFiles().then((loaded) => {
      if (!cancelled) setPaths(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [loadProjectFiles, refreshKey]);

  // Folding the paths is the expensive half and depends on nothing else,
  // so opening a folder re-walks the tree without re-sorting the project.
  const tree = useMemo(() => buildFileTree(paths ?? []), [paths]);
  const rows = useMemo(() => visibleRows(tree, expanded), [tree, expanded]);

  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  const open = async (path: string) => setOpenError(await onOpenFile(path));

  return (
    <aside className="files">
      <div className="changes__actions">
        <button
          type="button"
          className="changes__action changes__action--icon"
          aria-label="Refresh the file list"
          title="Refresh"
          onClick={() => setRefreshKey((key) => key + 1)}
        >
          <ArrowClockwise />
        </button>
      </div>

      {paths === null && <p className="changes__empty">Loading files…</p>}
      {paths !== null && rows.length === 0 && (
        <p className="changes__empty">This folder has no files to show.</p>
      )}
      {rows.length > 0 && (
        <ul className="changes__list">
          {rows.map((row) => (
            <FileTreeRow
              key={row.path}
              row={row}
              expanded={expanded.has(row.path)}
              onActivate={() =>
                row.isDirectory ? toggle(row.path) : void open(row.path)
              }
            />
          ))}
        </ul>
      )}
      {openError && <p className="changes__notice changes__notice--error">{openError}</p>}
    </aside>
  );
}

/** One line: a folder that opens, or a file that leaves for another app. */
function FileTreeRow({
  row,
  expanded,
  onActivate,
}: {
  row: FileRow;
  expanded: boolean;
  onActivate: () => void;
}) {
  return (
    <li
      className="changes__item files__row"
      style={{ paddingLeft: row.depth * INDENT }}
      title={row.path}
    >
      <button type="button" className="changes__file" onClick={onActivate}>
        {/* Files carry the spacer so their names line up under the
            folder names above them rather than under the carets. */}
        <span className="files__caret">
          {row.isDirectory &&
            (expanded ? <CaretDown size={12} /> : <CaretRight size={12} />)}
        </span>
        <span className="changes__filename">{row.name}</span>
      </button>
    </li>
  );
}
