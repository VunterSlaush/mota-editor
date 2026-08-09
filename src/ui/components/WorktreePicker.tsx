import { FolderSimple, GitFork } from "@phosphor-icons/react";
import { useEffect, useRef, useState } from "react";
import type { GitBranch, WorktreeAddMode } from "../../core/ports/gitPort";
import type { GitActionResult } from "../../core/usecases/gitActions";
import type { WorktreeItem } from "../../core/usecases/worktrees";

interface Props {
  /** The repo's checkouts, decorated with what's already open. */
  loadWorktrees: () => Promise<WorktreeItem[]>;
  /** Branches already known to the panel — candidates for new worktrees. */
  branches: readonly GitBranch[];
  onOpen: (path: string, mainPath: string) => void;
  onCreate: (branch: string, mode: WorktreeAddMode) => Promise<GitActionResult>;
  onClose: () => void;
}

/** One selectable row: an existing checkout, or a way to make one. */
type Row =
  | { readonly kind: "worktree"; readonly worktree: WorktreeItem }
  | { readonly kind: "branch"; readonly branch: GitBranch }
  | { readonly kind: "newBranch"; readonly name: string };

/**
 * UI — worktree picker, a sibling of BranchPicker: search on top, one
 * keyboard-navigable list below. Existing worktrees open as tabs; the
 * rows after them create a worktree first, then open it.
 */
export function WorktreePicker({
  loadWorktrees,
  branches,
  onOpen,
  onCreate,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [worktrees, setWorktrees] = useState<readonly WorktreeItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => inputRef.current?.focus(), []);

  // Load once per opening; the modal is remounted each time it opens.
  useEffect(() => {
    let cancelled = false;
    loadWorktrees().then((loaded) => {
      if (!cancelled) setWorktrees(loaded);
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = buildRows(worktrees ?? [], branches, query);
  const mainPath = worktrees?.find((w) => w.main)?.path ?? worktrees?.[0]?.path ?? "";

  const act = async (row: Row) => {
    if (busy) return;
    if (row.kind === "worktree") {
      if (!row.worktree.current) onOpen(row.worktree.path, mainPath);
      onClose();
      return;
    }
    const branch = row.kind === "branch" ? row.branch.name : row.name;
    const mode: WorktreeAddMode =
      row.kind === "newBranch" ? "new" : row.branch.remote ? "remote" : "existing";
    setBusy(true);
    setError(null);
    const result = await onCreate(branch, mode);
    setBusy(false);
    if (result.ok) {
      onClose();
    } else {
      setError(result.message);
      setWorktrees(await loadWorktrees()); // git may have half-succeeded
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setSelectedIndex((selectedIndex + delta + rows.length) % Math.max(rows.length, 1));
    } else if (e.key === "Enter" && rows.length > 0) {
      e.preventDefault();
      void act(rows[Math.min(selectedIndex, rows.length - 1)]);
    }
  };

  let lastKind: Row["kind"] | null = null;

  return (
    <div className="modal-overlay" onMouseDown={onClose}>
      <div
        className="branch-picker"
        role="dialog"
        aria-label="Open or create a worktree"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="branch-picker__search"
          placeholder="Search worktrees and branches…"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelectedIndex(0);
          }}
          onKeyDown={onKeyDown}
        />
        <div className="branch-picker__list" role="listbox">
          {worktrees === null && (
            <div className="branch-picker__empty">Loading worktrees…</div>
          )}
          {worktrees !== null && rows.length === 0 && (
            <div className="branch-picker__empty">Nothing matches "{query}"</div>
          )}
          {rows.map((row, index) => {
            const header =
              row.kind !== lastKind ? sectionTitle(row.kind, lastKind) : null;
            lastKind = row.kind;
            return (
              <div key={rowKey(row)}>
                {header && <div className="worktree-picker__section">{header}</div>}
                <div
                  role="option"
                  aria-selected={index === selectedIndex}
                  className={`branch-picker__item ${
                    index === selectedIndex ? "branch-picker__item--selected" : ""
                  } ${busy ? "worktree-picker__item--busy" : ""}`}
                  onMouseEnter={() => setSelectedIndex(index)}
                  onClick={() => void act(row)}
                >
                  <RowLabel row={row} />
                  <RowBadges row={row} />
                </div>
              </div>
            );
          })}
          {error && <div className="worktree-picker__error">{error}</div>}
        </div>
      </div>
    </div>
  );
}

/**
 * The selectable rows for the current query: existing worktrees first,
 * then branches that don't have one yet, then — when the query names no
 * known branch — creating that branch fresh.
 */
function buildRows(
  worktrees: readonly WorktreeItem[],
  branches: readonly GitBranch[],
  query: string,
): Row[] {
  const q = query.trim().toLowerCase();
  const matches = (text: string) => text.toLowerCase().includes(q);

  const checkouts = worktrees.filter((w) => !w.bare);
  const withWorktree = new Set(checkouts.map((w) => w.branch));
  const rows: Row[] = checkouts
    .filter((w) => matches(w.branch) || matches(w.path))
    .map((worktree) => ({ kind: "worktree", worktree }) as Row);

  rows.push(
    ...branches
      .filter((b) => !withWorktree.has(b.name) && matches(b.name))
      .map((branch) => ({ kind: "branch", branch }) as Row),
  );

  const name = query.trim();
  const known = (text: string) => text.toLowerCase() === name.toLowerCase();
  if (
    validBranchName(name) &&
    !branches.some((b) => known(b.name)) &&
    !checkouts.some((w) => known(w.branch))
  ) {
    rows.push({ kind: "newBranch", name });
  }
  return rows;
}

/** Enough validation for a picker; git has the final word. */
function validBranchName(name: string): boolean {
  return name.length > 0 && !name.startsWith("-") && !/\s/.test(name);
}

function sectionTitle(kind: Row["kind"], previous: Row["kind"] | null): string | null {
  if (kind === "worktree") return "Worktrees";
  if (previous === "worktree" || previous === null) return "New worktree";
  return null; // newBranch continues the "New worktree" section
}

function rowKey(row: Row): string {
  if (row.kind === "worktree") return `w:${row.worktree.path}`;
  if (row.kind === "branch") return `b:${row.branch.name}`;
  return "new";
}

function RowLabel({ row }: { row: Row }) {
  if (row.kind === "worktree") {
    const { worktree } = row;
    const name = worktree.branch || `detached @ ${worktree.head.slice(0, 7)}`;
    return (
      <span className="worktree-picker__label">
        {worktree.main ? (
          <FolderSimple size={14} aria-hidden="true" />
        ) : (
          <GitFork size={14} aria-hidden="true" />
        )}
        <span className="branch-picker__name">{name}</span>
        <span className="worktree-picker__path" title={worktree.path}>
          {worktree.path}
        </span>
      </span>
    );
  }
  if (row.kind === "branch") {
    return (
      <span className="branch-picker__name">＋ New worktree for {row.branch.name}</span>
    );
  }
  return (
    <span className="branch-picker__name">＋ Create branch "{row.name}" + worktree</span>
  );
}

function RowBadges({ row }: { row: Row }) {
  if (row.kind === "worktree") {
    const { worktree } = row;
    return (
      <span className="worktree-picker__badges">
        {worktree.main && <span className="branch-picker__remote">main</span>}
        {worktree.current && <span className="branch-picker__current">current</span>}
        {!worktree.current && worktree.openTabId && (
          <span className="branch-picker__current">open</span>
        )}
        {worktree.locked && <span className="branch-picker__remote">locked</span>}
      </span>
    );
  }
  if (row.kind === "branch" && row.branch.remote) {
    return <span className="branch-picker__remote">remote</span>;
  }
  return null;
}
