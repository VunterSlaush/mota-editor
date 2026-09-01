import type { Icon } from "@phosphor-icons/react";
import {
  ArrowClockwise,
  CaretDown,
  CaretRight,
  File,
  FileCode,
  FileCss,
  FileHtml,
  FileImage,
  FileJs,
  FileJsx,
  FileMd,
  FilePy,
  FileRs,
  FileText,
  FileTs,
  FileTsx,
  Folder,
  FolderOpen,
  MagnifyingGlass,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useState } from "react";
import { filterFiles } from "../../core/entities/fileMention";
import type { FileKind, FileRow } from "../../core/entities/fileTree";
import {
  buildFileTree,
  fileKind,
  rendersInApp,
  visibleRows,
} from "../../core/entities/fileTree";
import type { FileActions } from "../fileActions";
import { fileName, parentDir } from "../fileName";
import type { Point } from "./contextMenuPlacement";
import { FileContextMenu } from "./FileContextMenu";
import { MarkdownFileModal } from "./MarkdownFileModal";

interface Props {
  /** Every file in the project, flat. Stable across renders, or the
   *  effect below would refetch forever. */
  loadProjectFiles: () => Promise<string[]>;
  /** Everything a row can do to the file it names. */
  fileActions: FileActions;
}

/** How far one level of nesting shifts a row, in pixels. */
const INDENT = 12;

/** How many matches a search shows. Past this the answer is a better
 *  query, not more scrolling — and the ranking already put the likeliest
 *  ones on top. */
const SEARCH_LIMIT = 100;

/** The glyph for each kind of file. One per kind, so the row's icon says
 *  what the row is before its name is read. */
const KIND_ICONS: Readonly<Record<FileKind, Icon>> = {
  ts: FileTs,
  tsx: FileTsx,
  js: FileJs,
  jsx: FileJsx,
  style: FileCss,
  markup: FileHtml,
  data: FileCode,
  rust: FileRs,
  python: FilePy,
  markdown: FileMd,
  text: FileText,
  image: FileImage,
  plain: File,
};

/**
 * UI — the project's own files, as a tree.
 *
 * Clicking a markdown file opens it here, rendered: the app already
 * carries a markdown renderer for agent output, and a README is the file
 * you most often want to glance at without leaving (ADR-0019). Everything
 * else still goes to the operating system, which opens it in whatever the
 * user has that kind of file associated with — this app drives agents,
 * and pretending to be an editor would mean carrying one.
 *
 * A secondary click on a file offers the rest of that: open it with
 * something other than the default, or go find it in the file manager.
 *
 * Folders start closed. Opening one is the only state the panel keeps, and
 * it is deliberately not kept anywhere else — switching tabs and coming
 * back collapses the tree, exactly as the Changes panel forgets which of
 * its sections were open.
 *
 * Searching leaves the tree behind and answers with a ranked flat list:
 * once you know the name, the folder it lives in is a detail, and the
 * hierarchy is a wall between you and it.
 */
export function FilesPanel({ loadProjectFiles, fileActions }: Props) {
  const [paths, setPaths] = useState<readonly string[] | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const [refreshKey, setRefreshKey] = useState(0);
  const [openError, setOpenError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  /** The markdown file on screen, or null while none is. */
  const [viewing, setViewing] = useState<string | null>(null);
  /** The file whose secondary-click menu is up, and where it was clicked. */
  const [menu, setMenu] = useState<{ path: string; cursor: Point } | null>(null);

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
  const searching = query.trim() !== "";
  const matches = useMemo(
    () => (searching ? filterFiles(paths ?? [], query.trim(), SEARCH_LIMIT) : []),
    [paths, query, searching],
  );

  const toggle = (path: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(path)) next.add(path);
      return next;
    });

  /** Every desktop action reports back the same way, and a stale error
   *  under the tree would read as if the latest click had failed. */
  const attempt = (act: () => Promise<string | null>) => {
    setOpenError(null);
    void act().then(setOpenError);
  };

  const open = (path: string) => {
    setOpenError(null);
    if (rendersInApp(fileName(path))) setViewing(path);
    else attempt(() => fileActions.open(path));
  };

  return (
    <aside className="files">
      <div className="changes__actions">
        <div className="files__search">
          <MagnifyingGlass size={13} />
          <input
            className="files__search-input"
            value={query}
            placeholder="Search files…"
            aria-label="Search files"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Escape") return;
              // A right-click leaves the focus in this box, so Escape has
              // to dismiss the menu it opened before it clears anything —
              // stopping propagation here is what would swallow it.
              if (menu) {
                e.stopPropagation();
                setMenu(null);
              } else if (query !== "") {
                // Clears the box rather than closing the panel around it.
                e.stopPropagation();
                setQuery("");
              }
            }}
          />
        </div>
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
      {paths !== null && !searching && rows.length === 0 && (
        <p className="changes__empty">This folder has no files to show.</p>
      )}
      {searching && matches.length === 0 && (
        <p className="changes__empty">No file matches “{query.trim()}”.</p>
      )}
      {searching && matches.length > 0 && (
        <ul className="changes__list">
          {matches.map((path) => (
            <SearchResultRow
              key={path}
              path={path}
              onOpen={() => open(path)}
              onMenu={(cursor) => setMenu({ path, cursor })}
            />
          ))}
        </ul>
      )}
      {!searching && rows.length > 0 && (
        <ul className="changes__list">
          {rows.map((row) => (
            <FileTreeRow
              key={row.path}
              row={row}
              expanded={expanded.has(row.path)}
              onActivate={() => (row.isDirectory ? toggle(row.path) : open(row.path))}
              // Folders have none of the three actions; only files do.
              onMenu={
                row.isDirectory
                  ? undefined
                  : (cursor) => setMenu({ path: row.path, cursor })
              }
            />
          ))}
        </ul>
      )}
      {openError && <p className="changes__notice changes__notice--error">{openError}</p>}
      {menu && (
        <FileContextMenu
          path={menu.path}
          cursor={menu.cursor}
          onOpen={() => open(menu.path)}
          onOpenWith={() => attempt(() => fileActions.openWith(menu.path))}
          onReveal={() => attempt(() => fileActions.reveal(menu.path))}
          onClose={() => setMenu(null)}
        />
      )}
      {viewing && (
        <MarkdownFileModal
          path={viewing}
          load={() => fileActions.readMarkdown(viewing)}
          onOpenExternally={() => {
            setViewing(null);
            attempt(() => fileActions.open(viewing));
          }}
          onClose={() => setViewing(null)}
        />
      )}
    </aside>
  );
}

/** A row's secondary click, as the handler the menu needs: the webview's
 *  own menu is refused first, or it would draw on top of ours. */
function secondaryClick(onMenu: (cursor: Point) => void) {
  return (e: React.MouseEvent) => {
    e.preventDefault();
    onMenu({ x: e.clientX, y: e.clientY });
  };
}

/** One line: a folder that opens, or a file that leaves for another app. */
function FileTreeRow({
  row,
  expanded,
  onActivate,
  onMenu,
}: {
  row: FileRow;
  expanded: boolean;
  onActivate: () => void;
  /** Absent for a folder, which has no actions of its own. */
  onMenu?: (cursor: Point) => void;
}) {
  return (
    <li
      className="changes__item files__row"
      style={{ paddingLeft: row.depth * INDENT }}
      title={row.path}
    >
      <button
        type="button"
        className="changes__file files__button"
        onClick={onActivate}
        onContextMenu={onMenu && secondaryClick(onMenu)}
      >
        {/* Files carry the spacer so their names line up under the
            folder names above them rather than under the carets. */}
        <span className="files__caret">
          {row.isDirectory &&
            (expanded ? <CaretDown size={12} /> : <CaretRight size={12} />)}
        </span>
        {row.isDirectory ? <FolderIcon open={expanded} /> : <FileIcon name={row.name} />}
        <span className="changes__filename">{row.name}</span>
      </button>
    </li>
  );
}

/** One search hit: the file, then the folder it is in, dimmed. */
function SearchResultRow({
  path,
  onOpen,
  onMenu,
}: {
  path: string;
  onOpen: () => void;
  onMenu: (cursor: Point) => void;
}) {
  const dir = parentDir(path);
  return (
    <li className="changes__item files__row" title={path}>
      <button
        type="button"
        className="changes__file files__button"
        onClick={onOpen}
        onContextMenu={secondaryClick(onMenu)}
      >
        <span className="files__caret" />
        <FileIcon name={fileName(path)} />
        <span className="changes__filename">{fileName(path)}</span>
        {dir && <span className="changes__dir">{dir}</span>}
      </button>
    </li>
  );
}

/** Open or closed, and the one row colour that is not about file type. */
function FolderIcon({ open }: { open: boolean }) {
  return (
    <span className="files__icon files__icon--folder">
      {open ? <FolderOpen size={14} weight="fill" /> : <Folder size={14} weight="fill" />}
    </span>
  );
}

/** The glyph and colour of a file's kind. Colour rides the theme's own
 *  palette rather than a table of its own, so every theme — including the
 *  light ones — gets a set that belongs to it. */
function FileIcon({ name }: { name: string }) {
  const kind = fileKind(name);
  const Glyph = KIND_ICONS[kind];
  return (
    <span className={`files__icon files__icon--${kind}`}>
      <Glyph size={14} />
    </span>
  );
}
