import { FolderSimple, GitFork, Trash } from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { type BranchMatches, filterBranches } from "../../core/entities/branch";
import type { RemovalCheck } from "../../core/entities/worktree";
import { deriveBranchName } from "../../core/entities/worktree";
import type {
  GitBranch,
  WorktreeAddMode,
  WorktreeRemoveMode,
} from "../../core/ports/gitPort";
import type { GitActionResult } from "../../core/usecases/gitActions";
import type { WorktreeItem } from "../../core/usecases/worktrees";
import { branchListHint } from "./branchListHint";

interface Props {
  /** The repo's checkouts, decorated with what's already open. */
  loadWorktrees: () => Promise<WorktreeItem[]>;
  /** Branches already known to the panel — candidates for new worktrees. */
  branches: readonly GitBranch[];
  /** This tab's checked-out branch; "" on a detached HEAD. */
  currentBranch: string;
  onOpen: (path: string, mainPath: string) => void;
  onCreate: (branch: string, mode: WorktreeAddMode) => Promise<GitActionResult>;
  /** What removing this worktree would cost, asked when Remove is armed. */
  onCheckRemoval: (path: string) => Promise<RemovalCheck>;
  onRemove: (path: string, mode: WorktreeRemoveMode) => Promise<GitActionResult>;
  onClose: () => void;
}

/** A row armed for removal: the second click is the one that deletes. */
interface Armed {
  readonly path: string;
  readonly check: RemovalCheck;
}

/** One selectable row: an existing checkout, or a way to make one. */
type Row =
  | { readonly kind: "worktree"; readonly worktree: WorktreeItem }
  | { readonly kind: "branch"; readonly branch: GitBranch }
  // The branch this tab is on can't be checked out twice, so its row
  // forks a fresh branch off it instead — the parallel-work gesture.
  | { readonly kind: "fromCurrent"; readonly base: string; readonly name: string }
  | { readonly kind: "newBranch"; readonly name: string };

/** The rows to draw, plus what the branch section left out of them. */
interface PickerRows {
  readonly rows: Row[];
  readonly branchMatches: BranchMatches<GitBranch>;
}

/**
 * UI — worktree picker, a sibling of BranchPicker: search on top, one
 * keyboard-navigable list below. Existing worktrees open as tabs; the
 * rows after them create a worktree first, then open it.
 *
 * It borrows the branch picker's bounded list as well as its frame: the
 * branches without a worktree are the same thousands of refs, and
 * rendering a row for each of them froze the app on open.
 */
export function WorktreePicker({
  loadWorktrees,
  branches,
  currentBranch,
  onOpen,
  onCreate,
  onCheckRemoval,
  onRemove,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [worktrees, setWorktrees] = useState<readonly WorktreeItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [armed, setArmed] = useState<Armed | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

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

  const { rows, branchMatches } = useMemo(
    () => buildRows(worktrees ?? [], branches, currentBranch, query),
    [worktrees, branches, currentBranch, query],
  );
  const hint = branchListHint(branchMatches);
  const mainPath = worktrees?.find((w) => w.main)?.path ?? worktrees?.[0]?.path ?? "";

  // Arrow keys walk past the bottom of the list; without this the
  // selection ends up below the fold and Enter looks random.
  useEffect(() => {
    listRef.current
      ?.querySelector(".branch-picker__item--selected")
      ?.scrollIntoView({ block: "nearest" });
  }, [selectedIndex]);

  /** First click asks git what it would cost; the second click removes. */
  const arm = async (path: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setArmed({ path, check: await onCheckRemoval(path) });
    setBusy(false);
  };

  const confirmRemove = async (check: RemovalCheck) => {
    if (busy || !armed) return;
    setBusy(true);
    const result = await onRemove(armed.path, check.needsForce ? "force" : "safe");
    setBusy(false);
    setArmed(null);
    if (!result.ok) setError(result.message);
    setWorktrees(await loadWorktrees());
  };

  const act = async (row: Row) => {
    if (busy) return;
    if (row.kind === "worktree") {
      if (!row.worktree.current) onOpen(row.worktree.path, mainPath);
      onClose();
      return;
    }
    const branch = row.kind === "branch" ? row.branch.name : row.name;
    const mode: WorktreeAddMode =
      row.kind === "branch" ? (row.branch.remote ? "remote" : "existing") : "new";
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
        <div className="branch-picker__list" role="listbox" ref={listRef}>
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
                  {row.kind === "worktree" &&
                    !row.worktree.main &&
                    !row.worktree.current && (
                      <button
                        type="button"
                        className="worktree-picker__remove"
                        aria-label={`Remove the worktree at ${row.worktree.path}`}
                        onClick={(e) => {
                          e.stopPropagation(); // the row itself opens it
                          void arm(row.worktree.path);
                        }}
                      >
                        <Trash size={13} aria-hidden="true" />
                      </button>
                    )}
                </div>
                {armed?.path === (row.kind === "worktree" ? row.worktree.path : "") && (
                  <RemovalConfirm
                    check={armed.check}
                    busy={busy}
                    onCancel={() => setArmed(null)}
                    onConfirm={() => void confirmRemove(armed.check)}
                  />
                )}
              </div>
            );
          })}
          {error && <div className="worktree-picker__error">{error}</div>}
        </div>
        {hint && <p className="branch-picker__hint">{hint}</p>}
      </div>
    </div>
  );
}

/**
 * The selectable rows for the current query: existing worktrees first,
 * then branches that don't have one yet, then — when the query names no
 * known branch — creating that branch fresh.
 *
 * Only the branch section is bounded, by `filterBranches`: worktrees are
 * countable by hand, branches are not.
 */
function buildRows(
  worktrees: readonly WorktreeItem[],
  branches: readonly GitBranch[],
  currentBranch: string,
  query: string,
): PickerRows {
  const q = query.trim().toLowerCase();
  const matches = (text: string) => text.toLowerCase().includes(q);

  const checkouts = worktrees.filter((w) => !w.bare);
  const withWorktree = new Set(checkouts.map((w) => w.branch));
  const rows: Row[] = checkouts
    .filter((w) => matches(w.branch) || matches(w.path))
    .map((worktree) => ({ kind: "worktree", worktree }) as Row);

  // The current branch is always checked out here, so a second checkout
  // of it is impossible — fork a fresh branch off it instead.
  if (currentBranch && matches(currentBranch)) {
    const taken = [...branches.map((b) => b.name), ...withWorktree];
    rows.push({
      kind: "fromCurrent",
      base: currentBranch,
      name: deriveBranchName(currentBranch, taken),
    });
  }

  // A branch that already has a worktree is offered by that worktree's
  // own row above, so it never reaches the branch section.
  const branchMatches = filterBranches(
    branches.filter((b) => !withWorktree.has(b.name)),
    query,
  );
  rows.push(...branchMatches.shown.map((branch) => ({ kind: "branch", branch }) as Row));

  const name = query.trim();
  const known = (text: string) => text.toLowerCase() === name.toLowerCase();
  // Every branch is consulted here, shown or not: offering to create one
  // that already exists is a promise git would refuse.
  if (
    validBranchName(name) &&
    !branches.some((b) => known(b.name)) &&
    !checkouts.some((w) => known(w.branch))
  ) {
    rows.push({ kind: "newBranch", name });
  }
  return { rows, branchMatches };
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
  if (row.kind === "fromCurrent") return `c:${row.name}`;
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
  if (row.kind === "fromCurrent") {
    return (
      <span className="worktree-picker__label">
        <span className="branch-picker__name">＋ New worktree from {row.base}</span>
        <span className="worktree-picker__path">as new branch '{row.name}'</span>
      </span>
    );
  }
  return (
    <span className="branch-picker__name">＋ Create branch "{row.name}" + worktree</span>
  );
}

/**
 * The second half of the two-step: what removal would cost, and the
 * button that does it. A worktree with uncommitted work says so in the
 * button itself — "Delete 3 files" is harder to click by reflex than a
 * bare "Remove", which is the point.
 */
function RemovalConfirm({
  check,
  busy,
  onCancel,
  onConfirm,
}: {
  check: RemovalCheck;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const blocked = check.blockers.some(
    (b) => b.includes("main checkout") || b.startsWith("Locked") || b.includes("Not a"),
  );
  return (
    <div className="worktree-picker__confirm">
      <span className="worktree-picker__confirm-text">
        {check.blockers.length > 0
          ? check.blockers.join(" ")
          : "Deletes the folder. The branch and its commits stay."}
      </span>
      <button type="button" className="worktree-picker__confirm-no" onClick={onCancel}>
        Cancel
      </button>
      {!blocked && (
        <button
          type="button"
          className="worktree-picker__confirm-yes"
          disabled={busy}
          onClick={onConfirm}
        >
          {check.needsForce ? "Delete anyway" : "Remove"}
        </button>
      )}
    </div>
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
        {worktree.prunable && <span className="branch-picker__remote">gone</span>}
      </span>
    );
  }
  if (row.kind === "branch" && row.branch.remote) {
    return <span className="branch-picker__remote">remote</span>;
  }
  return null;
}
