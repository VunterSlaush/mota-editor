import { Plus, Sparkle, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import { tabLabel } from "../../core/entities/project";
import { providerById } from "../../core/entities/provider";
import type { BoundaryPreset } from "../../core/entities/subtask";
import { folderSuggestions } from "../../core/entities/worktree";
import type { TabState } from "../../core/state/appState";
import type { SuggestedPresets } from "../../core/usecases/subtasks";

interface Props {
  /** The project whose areas these are; null with no project open. */
  activeTab: TabState | null;
  /** Save the whole list — the caller validates and persists. */
  onSave: (presets: readonly BoundaryPreset[]) => Promise<string | undefined>;
  /** Ask an agent to name the areas. Spends tokens; only ever called
   *  after the user has confirmed the button that says so. */
  onSuggest: () => Promise<SuggestedPresets>;
  /** The project's folders, for the path suggestions. Stable identity. */
  loadFolders?: () => Promise<string[]>;
  newId: () => string;
}

/**
 * UI — subtask preferences: the named areas of this project, ready to
 * apply when scoping a subtask instead of re-picking folders each time.
 *
 * Per project, because the paths are: `apps/web` describes this
 * repository. That is why this section shows nothing without one open.
 */
export function SettingsSubtasks({
  activeTab,
  onSave,
  onSuggest,
  loadFolders,
  newId,
}: Props) {
  const [candidates, setCandidates] = useState<readonly string[]>([]);
  const [error, setError] = useState<string | null>(null);
  // The agent's answer, held for review: a suggestion is a draft until
  // someone accepts it, and it cost tokens to get — losing it to a
  // stray click would mean paying twice.
  const [suggested, setSuggested] = useState<readonly BoundaryPreset[] | null>(null);
  const [asking, setAsking] = useState(false);
  const [confirming, setConfirming] = useState(false);

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

  if (!activeTab) {
    return (
      <div className="settings-section">
        <h2 className="settings-section__title">Subtasks</h2>
        <p className="settings-section__hint">
          Areas belong to a project — open one to name its areas.
        </p>
      </div>
    );
  }

  const presets = activeTab.project.boundaryPresets ?? [];
  const provider = providerById(activeTab.project.provider).displayName;

  const save = async (next: readonly BoundaryPreset[]) => {
    setError((await onSave(next)) ?? null);
  };

  const ask = async () => {
    setConfirming(false);
    setAsking(true);
    setError(null);
    const result = await onSuggest();
    setAsking(false);
    if (result.problem) setError(result.problem);
    // Only what is new: re-suggesting must not offer an area twice.
    else setSuggested(result.presets.filter((s) => !namesAnArea(presets, s)));
  };

  const keepSuggested = async (preset: BoundaryPreset) => {
    setSuggested((current) => (current ?? []).filter((p) => p.id !== preset.id));
    await save([...presets, preset]);
  };

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Subtasks</h2>
      <p className="settings-section__hint">
        A subtask is another tab on this folder whose agent is read-only, or may write
        only inside folders you pick. Name those folder sets here once — the areas of a
        monorepo, say — and the subtask picker offers them as one click.
      </p>

      <h3 className="settings-section__subtitle">
        Areas in {tabLabel(activeTab.project)}
      </h3>

      {presets.length === 0 && (
        <p className="settings-section__hint">
          No areas yet. Add one below, or let {provider} propose them from the project's
          layout.
        </p>
      )}

      {presets.map((preset, index) => (
        <PresetRow
          key={preset.id}
          preset={preset}
          candidates={candidates}
          onChange={(next) => void save(presets.map((p, i) => (i === index ? next : p)))}
          onRemove={() => void save(presets.filter((_, i) => i !== index))}
        />
      ))}

      <button
        type="button"
        className="tool-add"
        onClick={() =>
          void save([...presets, { id: newId(), name: "New area", boundaries: [] }])
        }
      >
        <Plus size={14} /> Add an area
      </button>

      <h3 className="settings-section__subtitle">Propose areas with {provider}</h3>
      <p className="settings-section__hint">
        {provider} reads this project's folders and workspace files and proposes the areas
        it finds. Nothing is saved until you keep a proposal, and nothing runs until you
        press the button.
      </p>

      {!confirming && !asking && (
        <button
          type="button"
          className="tool-add"
          disabled={!loadFolders}
          onClick={() => {
            setConfirming(true);
            setError(null);
          }}
        >
          <Sparkle size={14} /> Propose areas…
        </button>
      )}

      {confirming && (
        <div className="worktree-picker__confirm">
          <span className="worktree-picker__confirm-text">
            This starts a {provider} agent and sends it one request — it reads your
            project's files to answer.{" "}
            <strong>It uses tokens from your {provider} plan</strong>, like any other
            message, and may take a minute. It runs read-only and cannot change any file.
          </span>
          <button
            type="button"
            className="worktree-picker__confirm-yes"
            onClick={() => void ask()}
          >
            Use {provider} and propose areas
          </button>
          <button
            type="button"
            className="changes__action"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </button>
        </div>
      )}

      {asking && (
        <p className="settings-section__hint">
          Asking {provider}… it is reading the project; this can take a minute.
        </p>
      )}

      {suggested && suggested.length === 0 && !asking && (
        <p className="settings-section__hint">
          Nothing new — {provider} proposed only areas you already have.
        </p>
      )}

      {suggested && suggested.length > 0 && (
        <>
          <h3 className="settings-section__subtitle">Proposed</h3>
          {suggested.map((preset) => (
            <div className="worktree-path-row" key={preset.id}>
              <span className="subtask-preset__proposed">
                <strong>{preset.name}</strong>
                <span className="settings-field__hint">
                  {preset.boundaries.join(", ")}
                </span>
              </span>
              <div className="worktree-path-row__side">
                <button
                  type="button"
                  className="changes__action"
                  onClick={() => void keepSuggested(preset)}
                >
                  Keep
                </button>
                <button
                  type="button"
                  className="tool-row__remove"
                  aria-label={`Discard the proposed area ${preset.name}`}
                  onClick={() =>
                    setSuggested((current) =>
                      (current ?? []).filter((p) => p.id !== preset.id),
                    )
                  }
                >
                  <Trash size={14} />
                </button>
              </div>
            </div>
          ))}
        </>
      )}

      {error && <p className="worktree-picker__error">{error}</p>}
    </div>
  );
}

/** Whether an area with this name is already saved (case-insensitively). */
function namesAnArea(
  presets: readonly BoundaryPreset[],
  preset: BoundaryPreset,
): boolean {
  return presets.some((p) => p.name.toLowerCase() === preset.name.toLowerCase());
}

/** UI — one named area: its name, its folders, and the way to drop it. */
function PresetRow({
  preset,
  candidates,
  onChange,
  onRemove,
}: {
  preset: BoundaryPreset;
  candidates: readonly string[];
  onChange: (next: BoundaryPreset) => void;
  onRemove: () => void;
}) {
  const [adding, setAdding] = useState("");
  const suggestions = adding.trim()
    ? folderSuggestions(candidates, adding, preset.boundaries)
    : [];

  const addFolder = (path: string) => {
    onChange({ ...preset, boundaries: [...preset.boundaries, path] });
    setAdding("");
  };

  return (
    <div className="subtask-preset">
      <div className="worktree-path-row">
        <input
          className="settings-input"
          aria-label="Area name"
          placeholder="Frontend"
          value={preset.name}
          onChange={(e) => onChange({ ...preset, name: e.target.value })}
        />
        <div className="worktree-path-row__side">
          <button
            type="button"
            className="tool-row__remove"
            aria-label={`Remove the area ${preset.name}`}
            onClick={onRemove}
          >
            <Trash size={14} />
          </button>
        </div>
      </div>

      <div className="subtask-preset__folders">
        {preset.boundaries.map((folder) => (
          <span className="subtask-preset__folder" key={folder}>
            {folder}
            <button
              type="button"
              aria-label={`Remove ${folder} from ${preset.name}`}
              onClick={() =>
                onChange({
                  ...preset,
                  boundaries: preset.boundaries.filter((f) => f !== folder),
                })
              }
            >
              ×
            </button>
          </span>
        ))}
        {preset.boundaries.length === 0 && (
          <span className="settings-field__hint">No folders yet.</span>
        )}
      </div>

      <div className="folder-suggest">
        <input
          className="settings-input"
          placeholder="Add a folder, relative to the project (e.g. apps/web)"
          value={adding}
          autoComplete="off"
          onChange={(e) => setAdding(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && adding.trim()) {
              e.preventDefault();
              addFolder(adding.trim());
            }
          }}
        />
        {suggestions.length > 0 && (
          <div
            className="folder-suggest__menu"
            role="listbox"
            aria-label="Project folders"
          >
            {suggestions.map((path) => (
              <div
                key={path}
                role="option"
                aria-selected={false}
                className="folder-suggest__item"
                onMouseDown={(e) => {
                  e.preventDefault(); // pick without blurring the input first
                  addFolder(path);
                }}
              >
                {path}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
