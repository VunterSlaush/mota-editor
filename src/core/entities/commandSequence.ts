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
  const root = findSequence(sequences, token);
  if (!root) return [];
  return expanded(sequences, root, args, new Set([key(root)]));
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

/** One sequence's steps, with the sequences on the path back to the root
 *  spliced in and the ones that would close a cycle dropped. */
function expanded(
  sequences: readonly CommandSequence[],
  sequence: CommandSequence,
  args: string,
  path: ReadonlySet<string>,
): string[] {
  const steps: string[] = [];
  for (const raw of sequence.steps) {
    if (steps.length >= MAX_SEQUENCE_STEPS) break;
    const step = expandPromptCommand(raw, args).trim();
    if (step === "") continue;

    const nested = findSequence(sequences, leadingCommand(step) ?? "");
    if (!nested) {
      steps.push(step);
      continue;
    }
    if (path.has(key(nested))) continue; // the step that would close the cycle
    const nestedArgs = step.slice((leadingCommand(step) ?? "").length).trim();
    steps.push(
      ...expanded(sequences, nested, nestedArgs, new Set([...path, key(nested)])),
    );
  }
  return steps.slice(0, MAX_SEQUENCE_STEPS);
}
