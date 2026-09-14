import { type CommandInfo, dedupeCommands, MOTA_COMMANDS } from "./command";
import { leadingCommand } from "./commandConfig";
import { expandPromptCommand } from "./extension";

/**
 * Entities layer — a named list of prompts the user runs as one command.
 *
 * A repeated workflow — review, then write tests, then commit — is three
 * things to type with a wait between each. A sequence names that list
 * once: step 1 sends, the rest queue behind it and fire as each turn
 * completes. A step is any prompt line, so slash commands, prose and
 * extension commands all keep working inside one.
 */
export interface CommandSequence {
  readonly id: string;
  /** As typed in settings; the leading slash is optional there. */
  readonly name: string;
  readonly description: string;
  readonly steps: readonly string[];
}

/**
 * The ceiling on what one invocation may expand to. A sequence is a
 * convenience, not a batch runner — fifty turns is already far past the
 * point where a user would rather watch and steer.
 */
export const MAX_SEQUENCE_STEPS = 50;

/** The invokable form of a sequence's name, or "" when there isn't one. */
export function normalizedSequenceName(name: string): string {
  // Only a leading token reaches `leadingCommand`, so anything after a
  // space could never be typed back — the name is that first token.
  const token = name.trim().split(/\s+/)[0] ?? "";
  const bare = token.replace(/^\/+/, "");
  return bare === "" ? "" : `/${bare}`;
}

/** Half-filled rows are drafts: a name and something to run, or nothing. */
export function isRunnableSequence(sequence: CommandSequence): boolean {
  return (
    normalizedSequenceName(sequence.name) !== "" &&
    sequence.steps.some((step) => step.trim().length > 0)
  );
}

/**
 * Whether Mota answers this name itself.
 *
 * A sequence outranks an extension command and an agent's own command of
 * the same name, but not `MOTA_COMMANDS`: those are handled before the
 * sequence branch in `SendPrompt` and would leave the setting dead. Said
 * once here so the palette, the executor and the settings row agree.
 */
export function isReservedSequenceName(name: string): boolean {
  const normalized = normalizedSequenceName(name).toLowerCase();
  return MOTA_COMMANDS.some((command) => command.name.toLowerCase() === normalized);
}

/** The sequence a leading token names, or null. Case-insensitive, so it
 *  matches what `filterCommands` offered in the palette. */
export function findSequence(
  sequences: readonly CommandSequence[],
  token: string,
): CommandSequence | null {
  const wanted = normalizedSequenceName(token).toLowerCase();
  if (wanted === "") return null;
  return (
    sequences.find(
      (sequence) =>
        usable(sequence) &&
        normalizedSequenceName(sequence.name).toLowerCase() === wanted,
    ) ?? null
  );
}

/**
 * Sequences as palette entries. Tagged `"sequence"` rather than
 * `"builtin"`: the palette keeps its own commands whatever a live
 * session advertises, and a sequence tagged as a builtin would vanish
 * the moment an ACP session reported the CLI's real command list.
 */
export function commandsFromSequences(
  sequences: readonly CommandSequence[],
): CommandInfo[] {
  return dedupeCommands(
    sequences.filter(usable).map((sequence) => ({
      name: normalizedSequenceName(sequence.name),
      description: sequence.description.trim() || describeSteps(sequence),
      source: "sequence" as const,
    })),
  );
}

/**
 * `commands`, with these sequences put in ahead of them — the precedence
 * `ListCommands` applies, said once because two screens need it live.
 *
 * Sequences already in `commands` are replaced rather than merged with,
 * which makes this idempotent: a list read from disk minutes ago can be
 * brought up to date by handing it back with the current sequences,
 * without another read and without a renamed one lingering under both
 * names. That is what lets the composer's palette answer for a sequence
 * the moment it is named, and the settings editor offer a step a
 * sequence that has not left the screen yet.
 */
export function withSequences(
  commands: readonly CommandInfo[],
  sequences: readonly CommandSequence[],
): CommandInfo[] {
  return dedupeCommands([
    ...commandsFromSequences(sequences),
    ...commands.filter((command) => command.source !== "sequence"),
  ]).sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Everything invoking `token` will run, in order and ready to send.
 *
 * Flattened eagerly, cycles cut with a visited set, because the steps
 * after the first re-enter `SendPrompt` through the prompt queue as
 * provenance-free strings: nothing downstream can tell one from a typed
 * prompt, so a depth counter could never see a cycle. A self-referential
 * sequence would instead be an async loop that unshifts a fresh copy of
 * its own steps every pass and never yields to a turn. Flattening makes
 * `execute`'s recursion provably one level deep.
 */
export function sequenceSteps(
  sequences: readonly CommandSequence[],
  token: string,
  args: string,
): readonly string[] {
  return sequenceExpansion(sequences, token, args).steps;
}

/**
 * What invoking `token` really runs, and what was left out getting there.
 *
 * `sequenceSteps` answers the executor's question and drops the rest on
 * the floor. The settings editor needs the floor: a step naming a
 * sequence that loops back is silently skipped, which reads as a bug in
 * the row rather than as the rule it is, and a nested sequence means the
 * step count on screen is not the number of turns the user is about to
 * start.
 */
export interface SequenceExpansion {
  /** The prompts that will be sent, in order. */
  readonly steps: readonly string[];
  /** Sequences a step named that would have looped back to one already
   *  running, in the order they were skipped. */
  readonly cycles: readonly string[];
  /** True when `MAX_SEQUENCE_STEPS` cut the expansion short. */
  readonly truncated: boolean;
}

export function sequenceExpansion(
  sequences: readonly CommandSequence[],
  token: string,
  args = "",
): SequenceExpansion {
  const root = findSequence(sequences, token);
  if (!root) return { steps: [], cycles: [], truncated: false };

  const found: Expansion = { steps: [], cycles: [], truncated: false };
  expand(sequences, root, args, new Set([key(root)]), found);
  return { ...found, cycles: [...new Set(found.cycles)] };
}

/**
 * Sequences as they come off disk, every row validated and unusable ones
 * dropped. A sequence that cannot run is not a restriction to fail
 * closed on — it is a command that would sit in the palette doing
 * nothing. Absent stays absent, so an older workspace file defaults.
 */
export function restoredSequences(raw: unknown): CommandSequence[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const sequences = raw
    .filter((s): s is Record<string, unknown> => typeof s === "object" && s !== null)
    .map((s) => ({
      id: typeof s.id === "string" ? s.id : "",
      name: typeof s.name === "string" ? s.name : "",
      description: typeof s.description === "string" ? s.description : "",
      steps: Array.isArray(s.steps)
        ? s.steps.filter((step): step is string => typeof step === "string")
        : [],
    }))
    .filter((s) => s.id !== "" && usable(s));
  return sequences.length > 0 ? sequences : undefined;
}

/** Runnable, and not a name that would never reach the sequence branch. */
function usable(sequence: CommandSequence): boolean {
  return isRunnableSequence(sequence) && !isReservedSequenceName(sequence.name);
}

function key(sequence: CommandSequence): string {
  return normalizedSequenceName(sequence.name).toLowerCase();
}

function describeSteps(sequence: CommandSequence): string {
  const count = sequence.steps.filter((step) => step.trim().length > 0).length;
  return `${count} ${count === 1 ? "step" : "steps"}`;
}

/** The traversal's running answer: one array for the executor, the rest
 *  for the settings row that has to explain what just happened. */
interface Expansion {
  readonly steps: string[];
  readonly cycles: string[];
  truncated: boolean;
}

/** Splice one sequence's steps into `found`, nested sequences resolved
 *  and the ones that would close a cycle recorded rather than run. */
function expand(
  sequences: readonly CommandSequence[],
  sequence: CommandSequence,
  args: string,
  path: ReadonlySet<string>,
  found: Expansion,
): void {
  for (const raw of sequence.steps) {
    if (found.steps.length >= MAX_SEQUENCE_STEPS) {
      // Only a step that had something to add counts as cut short: a
      // trailing blank row is not work the ceiling took away.
      found.truncated ||= expandPromptCommand(raw, args).trim() !== "";
      continue;
    }
    const step = expandPromptCommand(raw, args).trim();
    if (step === "") continue;

    const token = leadingCommand(step) ?? "";
    const nested = findSequence(sequences, token);
    if (!nested) {
      found.steps.push(step);
      continue;
    }
    if (path.has(key(nested))) {
      // The step that would close the cycle. Recorded, because silence
      // here reads as a step that simply does not work.
      found.cycles.push(normalizedSequenceName(nested.name));
      continue;
    }
    expand(
      sequences,
      nested,
      step.slice(token.length).trim(),
      new Set([...path, key(nested)]),
      found,
    );
  }
}
