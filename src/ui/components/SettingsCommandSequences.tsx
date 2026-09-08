import { Plus, Trash } from "@phosphor-icons/react";
import {
  type CommandSequence,
  isReservedSequenceName,
  isRunnableSequence,
  normalizedSequenceName,
} from "../../core/entities/commandSequence";
import type { AppSettings } from "../../core/state/appState";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  newId: () => string;
}

/**
 * UI — the user's own workflows, each a named list of prompts. Rows are
 * edited straight through `onChange`: a half-filled one is a draft, kept
 * in settings and flagged rather than blocked, exactly like a
 * half-written MCP server.
 */
export function SettingsCommandSequences({ settings, onChange, newId }: Props) {
  const sequences = settings.commandSequences;

  const replace = (next: readonly CommandSequence[]) =>
    onChange({ commandSequences: next });

  const update = (id: string, change: Partial<CommandSequence>) =>
    replace(sequences.map((s) => (s.id === id ? { ...s, ...change } : s)));

  const updateStep = (sequence: CommandSequence, index: number, step: string) =>
    update(sequence.id, {
      steps: sequence.steps.map((s, i) => (i === index ? step : s)),
    });

  const addStep = (sequence: CommandSequence) =>
    update(sequence.id, { steps: [...sequence.steps, ""] });

  const removeStep = (sequence: CommandSequence, index: number) =>
    update(sequence.id, { steps: sequence.steps.filter((_, i) => i !== index) });

  const add = () =>
    replace([...sequences, { id: newId(), name: "", description: "", steps: [""] }]);

  return (
    <div className="settings-section">
      <h2 className="settings-section__title">Command sequences</h2>
      <p className="settings-section__hint">
        A sequence names a list of prompts you run together. Invoking it sends the first
        step straight away and queues the rest, so they run back to back as each turn
        completes — no waiting to type the next one.
      </p>
      <p className="settings-section__hint">
        A step is any prompt: a slash command, plain prose, or both. Write{" "}
        <code>$ARGUMENTS</code> where a step should take what you typed after the
        sequence's name; steps that don't mention it get your text appended. A sequence
        wins over an extension or agent command of the same name, but not over the
        commands Mota answers itself. Stop discards whatever has not run yet.
      </p>

      {sequences.length === 0 && (
        <p className="settings-section__hint">No sequences yet.</p>
      )}

      {sequences.map((sequence) => (
        <div className="tool-row" key={sequence.id}>
          <div className="tool-row__fields">
            <input
              className="settings-input"
              placeholder="Name (e.g. ship)"
              value={sequence.name}
              onChange={(e) => update(sequence.id, { name: e.target.value })}
            />
            <input
              className="settings-input"
              placeholder="What it does, for the palette"
              value={sequence.description}
              onChange={(e) => update(sequence.id, { description: e.target.value })}
            />
            {sequence.steps.map((step, index) => (
              <div
                className="sequence-step"
                // Steps have no identity of their own, and the index is
                // stable for everything but a removal — which replaces
                // the whole list anyway.
                // biome-ignore lint/suspicious/noArrayIndexKey: a step is its position
                key={index}
              >
                <span className="sequence-step__number">{index + 1}</span>
                <input
                  className="settings-input"
                  placeholder="Prompt to send (e.g. /review $ARGUMENTS)"
                  value={step}
                  onChange={(e) => updateStep(sequence, index, e.target.value)}
                />
                <button
                  type="button"
                  className="tool-row__remove"
                  aria-label={`Remove step ${index + 1}`}
                  onClick={() => removeStep(sequence, index)}
                >
                  <Trash size={14} />
                </button>
              </div>
            ))}
            <button type="button" className="tool-add" onClick={() => addStep(sequence)}>
              <Plus size={14} /> Add a step
            </button>
          </div>
          <div className="tool-row__side">
            <button
              type="button"
              className="tool-row__remove"
              aria-label={`Remove ${sequence.name || "sequence"}`}
              onClick={() => replace(sequences.filter((s) => s.id !== sequence.id))}
            >
              <Trash size={14} />
            </button>
          </div>
          <SequenceProblem sequence={sequence} />
        </div>
      ))}

      <button type="button" className="tool-add" onClick={add}>
        <Plus size={14} /> Add a sequence
      </button>
    </div>
  );
}

/** Why this row will not answer to anything yet, if it will not. */
function SequenceProblem({ sequence }: { sequence: CommandSequence }) {
  if (isReservedSequenceName(sequence.name)) {
    return (
      <span className="tool-row__warning">
        Mota answers {normalizedSequenceName(sequence.name)} itself, so this sequence
        would never run. Choose another name.
      </span>
    );
  }
  if (!isRunnableSequence(sequence)) {
    return (
      <span className="tool-row__warning">
        Needs a name and at least one step before it appears as a command.
      </span>
    );
  }
  return null;
}
