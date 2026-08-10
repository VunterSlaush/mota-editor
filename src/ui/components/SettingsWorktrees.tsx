import { Plus, Trash } from "@phosphor-icons/react";
import type { ProvisionEntry, ProvisionStrategy } from "../../core/entities/worktree";
import { provisionPathProblem, shareRisk } from "../../core/entities/worktree";
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
}

/**
 * UI — worktree preferences: where new worktrees land, which remote a
 * remote-only branch comes from, what a worktree tab inherits, and how
 * the heavy folders git does not carry get stocked.
 */
export function SettingsWorktrees({ settings, onChange, supportsCow = null }: Props) {
  const worktrees = settings.worktrees;
  const patch = (changes: Partial<AppSettings["worktrees"]>) =>
    onChange({ worktrees: { ...worktrees, ...changes } });

  // A folder is named once, so its path is its identity. `add` refuses a
  // second blank row for the same reason: two rows with no path yet are
  // indistinguishable to the reader and to React.
  const entries = worktrees.provisioning;
  const replace = (next: readonly ProvisionEntry[]) => patch({ provisioning: next });
  const update = (path: string, changes: Partial<ProvisionEntry>) =>
    replace(entries.map((e) => (e.path === path ? { ...e, ...changes } : e)));
  const add = () => {
    if (entries.some((e) => !e.path.trim())) return;
    replace([...entries, { path: "", strategy: "clone" }]);
  };

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

      {entries.map((entry) => {
        const warning = rowWarning(entry, entries);
        return (
          <div className="worktree-path-row" key={entry.path}>
            <input
              className="settings-input"
              placeholder="Folder, relative to the repository (e.g. node_modules)"
              value={entry.path}
              onChange={(e) => update(entry.path, { path: e.target.value })}
            />
            <div className="worktree-path-row__side">
              <OptionPicker
                ariaLabel={`How to prepare ${entry.path || "this folder"}`}
                placement="bottom"
                disabled={false}
                value={entry.strategy}
                options={strategyOptions(supportsCow)}
                onChange={(strategy: ProvisionStrategy) =>
                  update(entry.path, { strategy })
                }
              />
              <button
                type="button"
                className="tool-row__remove"
                aria-label={`Stop preparing ${entry.path || "this folder"}`}
                onClick={() => replace(entries.filter((e) => e.path !== entry.path))}
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
