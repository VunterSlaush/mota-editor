import { Plus, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { ProvisionEntry, ProvisionStrategy } from "../../core/entities/worktree";
import {
  folderSuggestions,
  provisionPathProblem,
  shareRisk,
} from "../../core/entities/worktree";
import type { AppSettings } from "../../core/state/appState";
import { OptionPicker } from "./OptionPicker";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  /**
   * Whether the disk can copy-on-write, which decides what Copy costs.
   * Null while unknown — the wording then promises nothing either way.
   */
  supportsCow?: boolean | null;
  /**
   * The project's folders, for the path suggestions. Must be stable
   * across renders — it is an effect's dependency. Omitted with no
   * project open, and the inputs then take a typed path as before.
   */
  loadFolders?: () => Promise<string[]>;
}

/**
 * UI — worktree preferences: where new worktrees land, which remote a
 * remote-only branch comes from, what a worktree tab inherits, and how
 * the heavy folders git does not carry get stocked.
 */
export function SettingsWorktrees({
  settings,
  onChange,
  supportsCow = null,
  loadFolders,
}: Props) {
  const worktrees = settings.worktrees;
  const patch = (changes: Partial<AppSettings["worktrees"]>) =>
    onChange({ worktrees: { ...worktrees, ...changes } });

  // Rows are addressed by position, not by path: a path being typed
  // changes on every keystroke, and a row that changes identity mid-word
  // is remounted by React and loses the caret.
  const entries = worktrees.provisioning;
  const replace = (next: readonly ProvisionEntry[]) => patch({ provisioning: next });
  const update = (index: number, changes: Partial<ProvisionEntry>) =>
    replace(entries.map((e, i) => (i === index ? { ...e, ...changes } : e)));
  // A second blank row would be indistinguishable from the first.
  const add = () => {
    if (entries.some((e) => !e.path.trim())) return;
    replace([...entries, { path: "", strategy: "clone" }]);
  };

  // Read once per opening of this section: a folder scan is disk work,
  // and the answer does not change while someone types into it.
  const [candidates, setCandidates] = useState<readonly string[]>([]);
  useEffect(() => {
    if (!loadFolders) return;
    let cancelled = false;
    loadFolders()
      .then((folders) => {
        if (!cancelled) setCandidates(folders);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [loadFolders]);

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Worktrees</h2>
      <p className="settings-section__hint">
        A worktree is a second checkout of this repository, opened as its own tab with its
        own agent. Git shares the history; everything else is per worktree.
      </p>

      <Field
        label="Location"
        hint="Where new worktrees are created. Blank keeps them beside the repository."
      >
        <input
          className="settings-input"
          placeholder="<parent>/<repo>-worktrees"
          value={worktrees.container}
          onChange={(e) => patch({ container: e.target.value })}
        />
      </Field>

      <Field
        label="Remote"
        hint="Where a branch that only exists remotely is tracked from."
      >
        <input
          className="settings-input"
          placeholder="origin"
          value={worktrees.remote}
          onChange={(e) => patch({ remote: e.target.value })}
        />
      </Field>

      <Field
        label="Inherit tab settings"
        hint="A new worktree starts with the provider, model and mode of the tab it was opened from, rather than the app defaults."
      >
        <label className="worktree-path-row__toggle">
          <input
            type="checkbox"
            checked={worktrees.inheritFromSourceTab}
            onChange={(e) => patch({ inheritFromSourceTab: e.target.checked })}
          />
          Inherit from the tab it came from
        </label>
      </Field>

      <h3 className="settings-section__subtitle">Heavy folders</h3>
      <p className="settings-section__hint">
        Git carries none of these into a new worktree, so a fresh worktree cannot build
        until they are back. {copyHint(supportsCow)}
      </p>

      {entries.length === 0 && (
        <p className="settings-section__hint">
          Nothing is prepared — new worktrees start empty.
        </p>
      )}

      {entries.map((entry, index) => {
        const warning = rowWarning(entry, entries);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: position is the row's identity
          <div className="worktree-path-row" key={index}>
            <FolderInput
              value={entry.path}
              candidates={candidates}
              taken={entries.filter((_, i) => i !== index).map((e) => e.path)}
              onChange={(path) => update(index, { path })}
            />
            <div className="worktree-path-row__side">
              <OptionPicker
                ariaLabel={`How to prepare ${entry.path || "this folder"}`}
                placement="bottom"
                align="end"
                disabled={false}
                value={entry.strategy}
                options={strategyOptions(supportsCow)}
                onChange={(strategy: ProvisionStrategy) => update(index, { strategy })}
              />
              <button
                type="button"
                className="tool-row__remove"
                aria-label={`Stop preparing ${entry.path || "this folder"}`}
                onClick={() => replace(entries.filter((_, i) => i !== index))}
              >
                <Trash size={14} />
              </button>
            </div>
            {warning && <span className="tool-row__warning">{warning}</span>}
          </div>
        );
      })}

      <button type="button" className="tool-add" onClick={add}>
        <Plus size={14} /> Add a folder
      </button>
    </div>
  );
}

/**
 * UI — a folder path with the project's own folders offered underneath,
 * the composer's "@" menu wearing settings clothes: the same substring
 * match, the same arrows-and-Enter, the same mousedown that picks
 * without stealing focus first.
 */
function FolderInput({
  value,
  candidates,
  taken,
  onChange,
}: {
  value: string;
  candidates: readonly string[];
  taken: readonly string[];
  onChange: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [highlighted, setHighlighted] = useState(0);
  const suggestions = open ? folderSuggestions(candidates, value, taken) : [];

  const pick = (path: string) => {
    onChange(path);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape" && open) {
      e.preventDefault();
      setOpen(false);
    } else if (suggestions.length === 0) {
      return;
    } else if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      const delta = e.key === "ArrowDown" ? 1 : -1;
      setHighlighted((highlighted + delta + suggestions.length) % suggestions.length);
    } else if (e.key === "Enter") {
      e.preventDefault();
      pick(suggestions[Math.min(highlighted, suggestions.length - 1)]);
    }
  };

  return (
    <div className="folder-suggest">
      <input
        className="settings-input"
        placeholder="Folder, relative to the repository (e.g. node_modules)"
        value={value}
        autoComplete="off"
        aria-expanded={suggestions.length > 0}
        onChange={(e) => {
          onChange(e.target.value);
          setHighlighted(0);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={onKeyDown}
      />
      {suggestions.length > 0 && (
        <div className="folder-suggest__menu" role="listbox" aria-label="Project folders">
          {suggestions.map((path, index) => (
            <div
              key={path}
              role="option"
              aria-selected={index === highlighted}
              className={`folder-suggest__item ${
                index === highlighted ? "folder-suggest__item--selected" : ""
              }`}
              onMouseEnter={() => setHighlighted(index)}
              onMouseDown={(e) => {
                e.preventDefault(); // pick without blurring the input first
                pick(path);
              }}
            >
              {path}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The one thing most worth saying about a row, worst first. */
function rowWarning(
  entry: ProvisionEntry,
  entries: readonly ProvisionEntry[],
): string | undefined {
  const problem = provisionPathProblem(entry.path);
  if (problem) return problem;
  if (entries.filter((e) => e.path === entry.path).length > 1) {
    return "Listed twice — only the first is used.";
  }
  return entry.strategy === "share" ? shareRisk(entry.path) : undefined;
}

/**
 * Copy is the safe default everywhere, but only honest about its price
 * once we know whether the disk can clone instead of duplicating.
 */
function strategyOptions(supportsCow: boolean | null) {
  const copy =
    supportsCow === null
      ? "A private copy, made without duplicating the bytes where the disk allows."
      : supportsCow
        ? "A private copy. This disk clones, so it is instant and costs almost nothing."
        : "A private copy. This disk has no clone support, so it copies every byte.";
  return [
    { id: "clone" as const, label: "Copy", description: copy },
    {
      id: "share" as const,
      label: "Share",
      description:
        "One copy for every worktree. Build tools resolve it; the agent cannot read through it.",
    },
    {
      id: "skip" as const,
      label: "Skip",
      description: "Leave it out and install or build in the worktree yourself.",
    },
  ];
}

function copyHint(supportsCow: boolean | null): string {
  if (supportsCow === null) return "";
  return supportsCow
    ? "This disk supports cloning, so copying them is instant and nearly free."
    : "This disk cannot clone, so copying them takes their full size and time.";
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-field">
      <div className="settings-field__text">
        <span className="settings-field__label">{label}</span>
        <span className="settings-field__hint">{hint}</span>
      </div>
      <div className="settings-field__control">{children}</div>
    </div>
  );
}
