import { commandConfigKey } from "./commandConfig";
import type { SessionStats } from "./insights";
import type { ProviderId } from "./provider";
import { formatTokens } from "./tokens";

/**
 * Entities layer — a slash command distilled into a deterministic script.
 *
 * A command like /commit-push is a markdown prompt that makes the agent
 * re-derive the same procedure every run, many tool calls at a time. An
 * optimization replaces that with a user-approved shell script the agent
 * runs in a single call. Not every command qualifies: one that needs
 * judgment stays a prompt, and the record says why.
 */
export interface CommandOptimization {
  readonly status: "active" | "notOptimizable";
  /** POSIX sh; `{{placeholder}}` holes are filled by the agent at run time. */
  readonly script?: string;
  /**
   * A hybrid command's judgment steps, kept as concise prompt
   * instructions that orchestrate around the script. Absent when the
   * script covers everything. Still a saving: the agent reads this
   * distillation instead of the full command file, and the mechanical
   * part stays one tool call.
   */
  readonly instructions?: string;
  /** One line shown in the settings row. */
  readonly summary?: string;
  /** Why the command cannot be optimized, when it cannot. */
  readonly reason?: string;
  /** The instructions that block automation, each with a way out. */
  readonly blockers?: readonly OptimizationBlocker[];
  /**
   * Hash of the command markdown when it was analyzed. The approved
   * script never changes when the repo does — this only flags the row
   * as stale so the user can re-optimize.
   */
  readonly sourceHash: string;
  /**
   * When the script went live. Turns before this are the token baseline;
   * turns after are the optimized runs the savings are measured on.
   */
  readonly activatedAt?: number;
}

/**
 * One instruction that keeps a command from being deterministic, paired
 * with how the user could rewrite it — remove the step, shrink the
 * judgment to a `{{placeholder}}`, or split it into its own command. A
 * bare "not optimizable" is a dead end; this is the way forward.
 */
export interface OptimizationBlocker {
  /** The offending part of the command, quoted briefly. */
  readonly quote: string;
  /** What to change so it stops blocking. */
  readonly advice: string;
}

/** What the analysis run proposes, before the user has seen it. */
export type OptimizationProposal =
  | {
      readonly optimizable: true;
      readonly script: string;
      readonly instructions?: string;
      readonly summary?: string;
    }
  | {
      readonly optimizable: false;
      readonly reason: string;
      readonly blockers?: readonly OptimizationBlocker[];
    };

export type OptimizationVerdict =
  | { readonly kind: "proposal"; readonly proposal: OptimizationProposal }
  | { readonly kind: "invalid"; readonly error: string };

/**
 * Anything past this is not a distilled command, it is a program the
 * user cannot reasonably review in a settings row.
 */
const MAX_SCRIPT_LENGTH = 65536;

/**
 * Reads the analysis model's reply into a proposal. The contract asks
 * for one fenced JSON block, but replies drift — bare JSON and stray
 * prose around the fence are tolerated; anything else is an error the
 * settings row can show verbatim.
 */
export function parseOptimizationVerdict(text: string): OptimizationVerdict {
  let firstError: string | null = null;
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const verdict = validateVerdict(parsed);
    if (verdict.kind === "proposal") return verdict;
    firstError ??= verdict.error;
  }
  return {
    kind: "invalid",
    error: firstError ?? "The reply contained no JSON verdict.",
  };
}

/**
 * Fenced blocks first (the contract), then the whole reply as a fallback.
 * Any language tag is accepted — pairing only json-tagged fences would
 * mismatch openers with closers when other fences sit next to them, and
 * JSON.parse rejects the non-JSON blocks anyway.
 */
function jsonCandidates(text: string): string[] {
  const fenced = [...text.matchAll(/```[\w-]*[^\S\n]*\n([\s\S]*?)```/g)].map(
    (match) => match[1] ?? "",
  );
  return [...fenced, text.trim()];
}

function validateVerdict(parsed: unknown): OptimizationVerdict {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", error: "The verdict is not a JSON object." };
  }
  const record = parsed as Record<string, unknown>;
  if (typeof record.optimizable !== "boolean") {
    return { kind: "invalid", error: 'The verdict is missing "optimizable".' };
  }
  if (!record.optimizable) {
    if (typeof record.reason !== "string" || record.reason.trim() === "") {
      return { kind: "invalid", error: "A declined verdict must carry a reason." };
    }
    const blockers = parseBlockers(record.blockers);
    return {
      kind: "proposal",
      proposal: {
        optimizable: false,
        reason: record.reason.trim(),
        ...(blockers.length > 0 ? { blockers } : {}),
      },
    };
  }
  if (typeof record.script !== "string" || record.script.trim() === "") {
    return { kind: "invalid", error: "An optimizable verdict must carry a script." };
  }
  if (record.script.length > MAX_SCRIPT_LENGTH) {
    return { kind: "invalid", error: "The proposed script is implausibly large." };
  }
  if (
    typeof record.instructions === "string" &&
    record.instructions.length > MAX_SCRIPT_LENGTH
  ) {
    return {
      kind: "invalid",
      error: "The proposed instructions are implausibly large.",
    };
  }
  return {
    kind: "proposal",
    proposal: {
      optimizable: true,
      script: record.script.trim(),
      ...(typeof record.instructions === "string" && record.instructions.trim() !== ""
        ? { instructions: record.instructions.trim() }
        : {}),
      ...(typeof record.summary === "string" && record.summary.trim() !== ""
        ? { summary: record.summary.trim() }
        : {}),
    },
  };
}

/**
 * A not-optimizable command rewritten into an optimizable variant: the
 * new command file's text plus the script (and residual instructions)
 * implementing it. Saved as a COPY next to the original — the user's
 * command is never edited for them.
 */
export interface RewriteProposal {
  /** The rewritten command file content, markdown. */
  readonly command: string;
  readonly script: string;
  readonly instructions?: string;
  readonly summary?: string;
}

export type RewriteVerdict =
  | { readonly kind: "proposal"; readonly proposal: RewriteProposal }
  | { readonly kind: "invalid"; readonly error: string };

/** Reads the rewrite model's reply, with the same fence tolerance. */
export function parseRewriteVerdict(text: string): RewriteVerdict {
  let firstError: string | null = null;
  for (const candidate of jsonCandidates(text)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    const verdict = validateRewrite(parsed);
    if (verdict.kind === "proposal") return verdict;
    firstError ??= verdict.error;
  }
  return {
    kind: "invalid",
    error: firstError ?? "The reply contained no JSON rewrite.",
  };
}

function validateRewrite(parsed: unknown): RewriteVerdict {
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { kind: "invalid", error: "The rewrite is not a JSON object." };
  }
  const record = parsed as Record<string, unknown>;
  const command = typeof record.command === "string" ? record.command.trim() : "";
  const script = typeof record.script === "string" ? record.script.trim() : "";
  if (command === "" || script === "") {
    return {
      kind: "invalid",
      error: "A rewrite must carry both the command text and its script.",
    };
  }
  if (command.length > MAX_SCRIPT_LENGTH || script.length > MAX_SCRIPT_LENGTH) {
    return { kind: "invalid", error: "The proposed rewrite is implausibly large." };
  }
  return {
    kind: "proposal",
    proposal: {
      command,
      script,
      ...(typeof record.instructions === "string" && record.instructions.trim() !== ""
        ? { instructions: record.instructions.trim() }
        : {}),
      ...(typeof record.summary === "string" && record.summary.trim() !== ""
        ? { summary: record.summary.trim() }
        : {}),
    },
  };
}

/**
 * Blockers are advice, not the verdict — malformed entries are dropped
 * rather than failing a reply whose reason is perfectly usable.
 */
function parseBlockers(value: unknown): OptimizationBlocker[] {
  if (!Array.isArray(value)) return [];
  const blockers: OptimizationBlocker[] = [];
  for (const entry of value.slice(0, 10)) {
    if (typeof entry !== "object" || entry === null) continue;
    const { quote, advice } = entry as Record<string, unknown>;
    if (typeof quote !== "string" || typeof advice !== "string") continue;
    if (quote.trim() === "" || advice.trim() === "") continue;
    blockers.push({ quote: quote.trim(), advice: advice.trim() });
  }
  return blockers;
}

/** The live script for a command, if the user approved one. */
export function activeOptimization(
  optimizations: Readonly<Record<string, CommandOptimization>>,
  provider: ProviderId,
  command: string,
): CommandOptimization | undefined {
  const record = optimizations[commandConfigKey(provider, command)];
  return record?.status === "active" && record.script ? record : undefined;
}

/**
 * The prompt actually sent when an optimized command runs. The chat
 * keeps what the user typed; only the outgoing request carries this.
 * Everything the agent needs is inline, so the turn is one tool call
 * instead of a re-derived procedure.
 */
export function optimizedPrompt(
  command: string,
  typedText: string,
  optimization: CommandOptimization,
): string {
  const args = typedText.trim().slice(command.length).trim();
  const script = optimization.script ?? "";
  const instructions = optimization.instructions;
  const lines = instructions
    ? [
        `The user ran ${command}. It has a pre-approved implementation: the`,
        "instructions and the script below, which together REPLACE the command's",
        "original instructions entirely. Follow the instructions; where they call",
        "for the script, execute the ENTIRE script in a single shell tool call —",
        "never perform the script's steps yourself or add steps of your own.",
      ]
    : [
        `The user ran ${command}. It has a pre-approved deterministic implementation:`,
        "the script below. Execute the ENTIRE script in a single shell tool call.",
        "Do not perform its steps yourself, do not add steps, and do not consult the",
        "command's original instructions.",
      ];
  if (script.includes("{{")) {
    lines.push(
      "Before running it, replace every {{placeholder}} with a concrete value",
      "derived from the user's arguments and the repository state.",
    );
  }
  if (args !== "") {
    lines.push("", `Arguments: ${args}`);
  }
  if (instructions) {
    lines.push("", "Instructions:", instructions);
  }
  lines.push(
    "",
    "```sh",
    script,
    "```",
    "",
    "When it finishes, report the outcome briefly.",
  );
  return lines.join("\n");
}

/** True when the command's markdown changed after this record was made. */
export function isStale(
  optimization: CommandOptimization,
  currentHash: string | undefined,
): boolean {
  return currentHash !== undefined && currentHash !== optimization.sourceHash;
}

/**
 * What a command actually did across its recorded runs — measured
 * telemetry from past sessions, the strongest evidence the optimizer
 * can get about which steps really happen and how mechanical they are.
 */
export interface CommandRunEvidence {
  readonly runs: number;
  readonly avgTokens: number | null;
  readonly avgDurationMs: number | null;
  /** Average tool calls per run, by tool kind (execute, read, edit…). */
  readonly toolCallsPerRun: Readonly<Record<string, number>>;
}

export function commandRunEvidence(
  sessions: readonly SessionStats[],
  provider: ProviderId,
  command: string,
): CommandRunEvidence | null {
  let runs = 0;
  let tokens = 0;
  let tokenRuns = 0;
  let duration = 0;
  let durationRuns = 0;
  const tools = new Map<string, number>();

  for (const session of sessions) {
    if (session.provider !== provider) continue;
    for (const turn of session.turns) {
      if (turn.command !== command) continue;
      runs += 1;
      if (turn.tokens !== undefined) {
        tokens += turn.tokens;
        tokenRuns += 1;
      }
      if (turn.durationMs !== undefined) {
        duration += turn.durationMs;
        durationRuns += 1;
      }
      for (const [kind, count] of Object.entries(turn.toolCounts)) {
        tools.set(kind, (tools.get(kind) ?? 0) + count);
      }
    }
  }
  if (runs === 0) return null;

  const toolCallsPerRun = Object.fromEntries(
    [...tools.entries()]
      .map(([kind, total]) => [kind, Math.round((total / runs) * 10) / 10] as const)
      .filter(([, perRun]) => perRun > 0)
      .sort((a, b) => Number(b[1]) - Number(a[1])),
  );
  return {
    runs,
    avgTokens: tokenRuns > 0 ? Math.round(tokens / tokenRuns) : null,
    avgDurationMs: durationRuns > 0 ? Math.round(duration / durationRuns) : null,
    toolCallsPerRun,
  };
}

/** The evidence as one prompt-ready paragraph; null when there is none. */
export function formatRunEvidence(evidence: CommandRunEvidence | null): string | null {
  if (evidence === null) return null;
  const parts = [`${evidence.runs} recorded run${evidence.runs === 1 ? "" : "s"}`];
  if (evidence.avgTokens !== null) {
    parts.push(`~${formatTokens(evidence.avgTokens)} tokens per run`);
  }
  if (evidence.avgDurationMs !== null) {
    parts.push(`~${Math.round(evidence.avgDurationMs / 1000)}s per run`);
  }
  const tools = Object.entries(evidence.toolCallsPerRun)
    .slice(0, 6)
    .map(([kind, perRun]) => `${kind} x${perRun}`)
    .join(", ");
  const toolLine = tools === "" ? "" : `; tool calls per run: ${tools}`;
  return `${parts.join(", ")}${toolLine}.`;
}
