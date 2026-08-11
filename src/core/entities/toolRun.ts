import type { ChatMessage } from "./message";

/**
 * Entities layer — transcript grouping for the chat's quiet rows: the
 * fine pass that folds consecutive same-tool calls into one counted row,
 * and the coarse pass that collapses a whole run of tool and thought
 * rows into one summarised group ("Ran 3 commands, read 2 files").
 * Pure data work; the components only render what comes out.
 */

/** Aggregate lifecycle of a (possibly grouped) tool row. */
export type RowStatus = "running" | "completed" | "failed";

/** A transcript row: one message, standing in for `count` grouped ones. */
export interface Row {
  readonly message: ChatMessage;
  readonly count: number;
  /** Newline-joined details of every run in the group (tool rows only). */
  readonly detail: string;
  /** Worst status across the group; undefined for legacy tool rows. */
  readonly status?: RowStatus;
}

/** One tool call's contribution to its row's aggregate status. */
function statusOf(message: ChatMessage): RowStatus | undefined {
  const status = message.toolCall?.status;
  if (!status) return undefined;
  if (status === "failed") return "failed";
  if (status === "completed") return "completed";
  return "running"; // pending, in_progress, and unknown strings
}

/** Failed beats running beats completed: the group shows its worst news. */
function mergeStatus(a?: RowStatus, b?: RowStatus): RowStatus | undefined {
  if (a === "failed" || b === "failed") return "failed";
  if (a === "running" || b === "running") return "running";
  return a ?? b;
}

/** A tool row with reported output/locations is worth its own row —
 *  collapsing it into a group would hide what it brought back. */
function hasSubstance(message: ChatMessage): boolean {
  const call = message.toolCall;
  return Boolean(call && (call.content.length > 0 || call.locations.length > 0));
}

/**
 * Collapse consecutive runs of the same tool into one row with a count.
 * An agent that searches four times in a row would otherwise print four
 * separate "search" lines; one row saying "search ×4" with the four
 * queries stacked under it reads far better. Grouping is by tool name
 * only — the individual details are kept and listed inside the row
 * (exact duplicate details collapse to one line).
 */
export function groupToolRuns(messages: readonly ChatMessage[]): Row[] {
  const rows: Row[] = [];
  for (const message of messages) {
    const prev = rows[rows.length - 1];
    if (
      prev &&
      message.role === "tool" &&
      prev.message.role === "tool" &&
      prev.message.toolName === message.toolName &&
      !hasSubstance(message) &&
      !hasSubstance(prev.message)
    ) {
      const lines = prev.detail.split("\n");
      const detail = lines.includes(message.text)
        ? prev.detail
        : `${prev.detail}\n${message.text}`;
      rows[rows.length - 1] = {
        message: prev.message,
        count: prev.count + 1,
        detail,
        status: mergeStatus(prev.status, statusOf(message)),
      };
    } else {
      rows.push({ message, count: 1, detail: message.text, status: statusOf(message) });
    }
  }
  return rows;
}

/** Rows that are the agent's process, not its answer. */
const QUIET_ROLES: ReadonlySet<string> = new Set(["tool", "thought"]);

function isQuiet(row: Row): boolean {
  return QUIET_ROLES.has(row.message.role);
}

/** What one collapsed run says for itself. */
export interface RunSummary {
  /** "Ran 3 commands, read 2 files · 1 failed" */
  readonly label: string;
  /** Failed tool rows in the run (a folded row counts whole). */
  readonly failed: number;
  /** Worst status across the run; undefined for legacy-only rows. */
  readonly status?: RowStatus;
}

/** One transcript item after the coarse pass: a plain row, or a
 *  collapsed run of quiet rows (tools + thoughts). */
export type TranscriptItem =
  | { readonly kind: "row"; readonly row: Row }
  | {
      readonly kind: "group";
      /** The run's rows, identity preserved — expansion renders these. */
      readonly rows: readonly Row[];
      /** First message id — stable identity for keys and UI state. */
      readonly id: string;
      /** Tail run of a busy turn: still growing — shown with a spinner
       *  and the current activity, its counts ticking up as it works. */
      readonly live: boolean;
      readonly summary: RunSummary;
    };

/**
 * Segment rows into transcript items. A group is a maximal run of quiet
 * rows bounded by non-quiet rows or the transcript's ends; even a lone
 * tool line groups, because a single line of process should be just as
 * muted as ten. While the turn is busy and the transcript still ends in
 * quiet rows, that tail run is `live` — the work is happening NOW, so
 * its summary shows a spinner and the current activity instead of
 * pretending the run is finished.
 */
export function segmentQuietRuns(rows: readonly Row[], busy: boolean): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  let run: Row[] = [];
  const flush = (live: boolean) => {
    if (run.length === 0) return;
    items.push({
      kind: "group",
      rows: run,
      id: run[0].message.id,
      live,
      summary: summarizeRun(run),
    });
    run = [];
  };
  for (const row of rows) {
    if (isQuiet(row)) {
      run.push(row);
    } else {
      flush(false);
      items.push({ kind: "row", row });
    }
  }
  flush(busy); // only the tail run can be mid-flight
  return items;
}

/** The phrase each tool kind contributes, in the order phrases appear —
 *  fixed, so a still-growing run never reshuffles its own label. */
const RUN_PHRASES = [
  { kind: "execute", verb: "ran", noun: "command", plural: "commands" },
  { kind: "read", verb: "read", noun: "file", plural: "files" },
  { kind: "edit", verb: "edited", noun: "file", plural: "files" },
  { kind: "search", verb: "ran", noun: "search", plural: "searches" },
  { kind: "fetch", verb: "fetched", noun: "page", plural: "pages" },
] as const;

/** Kinds that are process-of-thought, never counted as actions. */
const UNCOUNTED_KINDS: ReadonlySet<string> = new Set(["think", "thought"]);

/**
 * Compose the run's one-line summary. Counts tool rows only (thoughts
 * are absorbed but not advertised); unknown kinds land in a generic
 * "other actions" tail so nothing the agent did goes uncounted.
 */
export function summarizeRun(rows: readonly Row[]): RunSummary {
  const counts = new Map<string, number>();
  let thoughts = 0;
  let failed = 0;
  let status: RowStatus | undefined;
  for (const row of rows) {
    if (row.message.role === "thought") {
      thoughts += 1;
      continue;
    }
    status = mergeStatus(status, row.status);
    if (row.status === "failed") failed += row.count;
    const kind = row.message.toolCall?.toolKind ?? row.message.toolName ?? "other";
    if (UNCOUNTED_KINDS.has(kind)) continue;
    counts.set(kind, (counts.get(kind) ?? 0) + row.count);
  }

  const phrases: string[] = [];
  for (const phrase of RUN_PHRASES) {
    const n = counts.get(phrase.kind);
    if (!n) continue;
    counts.delete(phrase.kind);
    phrases.push(`${phrase.verb} ${n} ${n === 1 ? phrase.noun : phrase.plural}`);
  }
  let other = 0;
  for (const n of counts.values()) other += n;
  if (other > 0)
    phrases.push(`took ${other} other ${other === 1 ? "action" : "actions"}`);

  let label =
    phrases.length > 0
      ? capitalize(phrases.join(", "))
      : `${thoughts} ${thoughts === 1 ? "thought" : "thoughts"}`;
  if (failed > 0) label = `${label} · ${failed} failed`;
  return { label, failed, status };
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
