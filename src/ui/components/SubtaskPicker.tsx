import { useEffect, useMemo, useRef, useState } from "react";
import { filterFiles } from "../../core/entities/fileMention";
import type { BoundaryPreset, SubtaskScope } from "../../core/entities/subtask";
import { boundaryPathProblem, normalizedBoundaries } from "../../core/entities/subtask";

/** Deep repositories list a lot of folders; the search is how you reach
 *  the rest, and a wall of checkboxes is nobody's idea of a picker. */
const FOLDER_ROW_LIMIT = 300;

interface Props {
  /** The project's folders, candidates for a write boundary. */
  loadFolders: () => Promise<string[]>;
  /** The project's saved areas — one click instead of re-picking folders. */
  presets: readonly BoundaryPreset[];
  /** Set when editing an existing subtask; absent when creating one. */
  initialScope?: SubtaskScope;
  /** Create or re-scope. Resolves with what is wrong, or undefined. */
  onSubmit: (scope: SubtaskScope) => Promise<string | undefined>;
  onClose: () => void;
}

/**
 * UI — the subtask picker: choose how far the new tab's agent may go.
 * Read-only needs nothing more; a write boundary is picked from the
 * project's own folders (the same candidates the worktree settings
 * suggest), with a typed path for anything the shallow listing missed.
 *
 * The same dialog edits an existing subtask's scope — it then says out
 * loud that saving restarts the agent session, because it does.
 */
export function SubtaskPicker({
  loadFolders,
  presets,
  initialScope,
  onSubmit,
  onClose,
}: Props) {
  const editing = initialScope !== undefined;
  const [access, setAccess] = useState<SubtaskScope["access"]>(
    initialScope?.access ?? "read-only",
  );
  const [selected, setSelected] = useState<readonly string[]>(
    initialScope?.boundaries ?? [],
  );
  const [candidates, setCandidates] = useState<readonly string[]>([]);
  const [search, setSearch] = useState("");
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    loadFolders()
      .then((folders) => {
        if (!cancelled) setCandidates(folders);
      })
      .catch(() => setCandidates([]));
    return () => {
      cancelled = true;
    };
    // Load once per opening; the modal is remounted each time it opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [onClose]);

  const toggle = (folder: string) => {
    setError(null);
    setSelected((current) =>
      current.includes(folder)
        ? current.filter((f) => f !== folder)
        : [...current, folder],
    );
  };

  /** The typed path joins the selection like a clicked one. */
  const addTyped = () => {
    const problem = boundaryPathProblem(typed);
    if (problem) {
      setError(problem);
      return;
    }
    const [folder] = normalizedBoundaries([typed]);
    if (folder && !selected.includes(folder)) setSelected([...selected, folder]);
    setTyped("");
    setError(null);
  };

  const submit = async () => {
    if (busy) return;
    const scope: SubtaskScope =
      access === "boundary"
        ? { access: "boundary", boundaries: selected }
        : { access: "read-only" };
    setBusy(true);
    const problem = await onSubmit(scope);
    setBusy(false);
    if (problem) setError(problem);
    else onClose();
  };

  /** A saved area replaces the selection — it IS the answer, not an addition. */
  const applyPreset = (preset: BoundaryPreset) => {
    setAccess("boundary");
    setSelected(normalizedBoundaries(preset.boundaries));
    setError(null);
  };

  // Selected folders the shallow candidate listing does not know (typed
  // by hand, or listed before a rename) still need a visible checkbox.
  const known = useMemo(
    () => [...candidates, ...selected.filter((f) => !candidates.includes(f))],
    [candidates, selected],
  );
  // The search narrows the list, but never hides what is already picked:
  // a filtered-out selection you cannot see is one you cannot uncheck.
  const shownFolders = useMemo(() => {
    const matched = filterFiles(known, search, FOLDER_ROW_LIMIT);
    const missing = selected.filter((folder) => !matched.includes(folder));
    return [...missing, ...matched];
  }, [known, search, selected]);

  return (
    <div className="modal-overlay modal-overlay--center" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="subtask-picker"
        role="dialog"
        aria-label={editing ? "Edit subtask scope" : "New subtask"}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h2 className="subtask-picker__title">
          {editing ? "Edit subtask scope" : "New subtask"}
        </h2>
        <p className="subtask-picker__hint">
          {editing
            ? "Saving restarts this tab's agent session under the new scope."
            : "Another tab on this folder, with less authority for its agent."}
        </p>

        <label className="subtask-picker__option">
          <input
            type="radio"
            name="subtask-access"
            checked={access === "read-only"}
            onChange={() => setAccess("read-only")}
          />
          <span>
            <strong>Read-only</strong> — the agent reads and answers; no edits, no
            commands.
          </span>
        </label>
        <label className="subtask-picker__option">
          <input
            type="radio"
            name="subtask-access"
            checked={access === "boundary"}
            onChange={() => setAccess("boundary")}
          />
          <span>
            <strong>Write boundaries</strong> — the agent reads anywhere in the project,
            but writes only inside the folders picked below.
          </span>
        </label>

        {access === "boundary" && (
          <>
            {presets.length > 0 && (
              <div className="subtask-picker__presets">
                <span className="settings-field__hint">Saved areas</span>
                <div className="subtask-picker__preset-row">
                  {presets.map((preset) => (
                    <button
                      type="button"
                      key={preset.id}
                      className="changes__action"
                      title={preset.boundaries.join(", ")}
                      onClick={() => applyPreset(preset)}
                    >
                      {preset.name}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <input
              className="settings-input"
              placeholder="Search folders…"
              value={search}
              autoComplete="off"
              aria-label="Search the project's folders"
              onChange={(e) => setSearch(e.target.value)}
            />
            <div className="subtask-picker__folders">
              {shownFolders.length === 0 && (
                <p className="changes__empty">
                  {search.trim()
                    ? `Nothing matches "${search.trim()}" — type an exact path below.`
                    : "No folders found — type one below."}
                </p>
              )}
              {shownFolders.map((folder) => (
                <label key={folder} className="subtask-picker__folder">
                  <input
                    type="checkbox"
                    checked={selected.includes(folder)}
                    onChange={() => toggle(folder)}
                  />
                  <span>{folder}</span>
                </label>
              ))}
            </div>
            <div className="subtask-picker__typed">
              <input
                className="settings-input"
                placeholder="apps/frontend"
                value={typed}
                onChange={(e) => {
                  setTyped(e.target.value);
                  setError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addTyped();
                  }
                }}
              />
              <button
                type="button"
                className="changes__action"
                disabled={typed.trim() === ""}
                onClick={addTyped}
              >
                Add folder
              </button>
            </div>
          </>
        )}

        {access === "boundary" && selected.length > 0 && (
          <p className="settings-field__hint">
            {selected.length === 1 ? "1 folder" : `${selected.length} folders`} selected:{" "}
            {selected.join(", ")}
          </p>
        )}

        {error && <p className="worktree-picker__error">{error}</p>}

        <div className="subtask-picker__actions">
          <button type="button" className="changes__action" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="changes__action subtask-picker__submit"
            disabled={busy || (access === "boundary" && selected.length === 0)}
            onClick={() => void submit()}
          >
            {editing ? "Save scope" : "Open subtask"}
          </button>
        </div>
      </div>
    </div>
  );
}
