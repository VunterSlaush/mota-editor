import { Plus, Trash } from "@phosphor-icons/react";
import { useEffect, useState } from "react";
import type { CommandInfo } from "../../core/entities/command";
import {
  type CommandSequence,
  isReservedSequenceName,
  isRunnableSequence,
  normalizedSequenceName,
  sequenceExpansion,
  withSequences,
} from "../../core/entities/commandSequence";
import type { ProviderId } from "../../core/entities/provider";
import type { AppSettings } from "../../core/state/appState";
import { CommandSuggest } from "./CommandSuggest";

interface Props {
  settings: AppSettings;
  onChange: (patch: Partial<AppSettings>) => void;
  newId: () => string;
  loadCommands: (provider: ProviderId) => Promise<CommandInfo[]>;
}

/**
 * UI — the user's own workflows, each a named list of prompts. Rows are
 * edited straight through `onChange`: a half-filled one is a draft, kept
 * in settings and flagged rather than blocked, exactly like a
 * half-written MCP server.
 */
export function SettingsCommandSequences({
  settings,
  onChange,
  newId,
  loadCommands,
}: Props) {
  const sequences = settings.commandSequences;
  const [discovered, setDiscovered] = useState<readonly CommandInfo[]>([]);

  // Read once, for the default provider: a sequence is global, so there
  // is no one provider whose list is the right one, and the commands a
  // step is likely to name are the same either way. The sequences being
  // typed are merged in below rather than re-read, which is what lets a
  // row name one that has not left this screen yet.
  useEffect(() => {
    let cancelled = false;
    loadCommands(settings.defaultProvider).then((loaded) => {
      if (!cancelled) setDiscovered(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [loadCommands, settings.defaultProvider]);

  const commands = withSequences(discovered, sequences);

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
        A step is any prompt: a slash command, plain prose, or both. Type <code>/</code>{" "}
        in a step to pick from the same commands the composer offers — including your
        other sequences, which run in place as part of this one. Write{" "}
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
                <CommandSuggest
                  value={step}
                  onChange={(next) => updateStep(sequence, index, next)}
                  commands={commands}
                  placeholder="Prompt to send (e.g. /review $ARGUMENTS)"
                  ariaLabel={`Step ${index + 1}`}
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
          <SequenceProblem sequence={sequence} sequences={sequences} />
        </div>
      ))}

      <button type="button" className="tool-add" onClick={add}>
        <Plus size={14} /> Add a sequence
      </button>
    </div>
  );
}

/**
 * What this row will really do, or why it will do nothing.
 *
 * The expansion is worth saying out loud because a step naming another
 * sequence is one line on screen and any number of turns in practice —
 * and because a step that loops back is skipped silently, which reads as
 * a step that does not work rather than as the rule it is.
 */
function SequenceProblem({
  sequence,
  sequences,
}: {
  sequence: CommandSequence;
  sequences: readonly CommandSequence[];
}) {
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

  const { steps, cycles, truncated } = sequenceExpansion(sequences, sequence.name);
  const written = sequence.steps.filter((step) => step.trim() !== "").length;
  return (
    <>
      {steps.length !== written && (
        <span className="tool-row__cost">
          Runs {steps.length} {steps.length === 1 ? "prompt" : "prompts"} in all, once the
          sequences it names are spelled out.
        </span>
      )}
      {cycles.length > 0 && (
        <span className="tool-row__warning">
          {cycles.join(", ")} {cycles.length === 1 ? "is" : "are"} already running by the
          time that step is reached, so it is skipped — a sequence cannot contain itself.
        </span>
      )}
      {truncated && (
        <span className="tool-row__warning">
          Stops after {steps.length} prompts. Anything past that is not run.
        </span>
      )}
    </>
  );
}
