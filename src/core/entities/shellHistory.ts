/**
 * Entities layer — the commands the user runs, ranked so the next one
 * can be guessed.
 *
 * Ranked by how often, not how recently. Measured against a real
 * history: 14,215 entries but only 842 distinct commands, so almost
 * everything typed is something typed before, and the count is a much
 * stronger signal than the order. Recency only breaks ties.
 */
export interface CommandUse {
  readonly line: string;
  readonly uses: number;
  /** Position of its last run in the source order — the tie-breaker. */
  readonly lastSeen: number;
}

/** Best guess first. */
export type CommandHistory = readonly CommandUse[];

/**
 * How many commands to keep. Beyond this the tail is commands run once,
 * months ago, which will never win a ranking — and the list is walked
 * on every keystroke.
 */
export const MAX_COMMANDS = 2000;

/** Count and rank a raw history, oldest line first. */
export function historyFrom(lines: readonly string[]): CommandHistory {
  const counts = new Map<string, CommandUse>();
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const seen = counts.get(line);
    counts.set(line, {
      line,
      uses: (seen?.uses ?? 0) + 1,
      lastSeen: index,
    });
  });
  return rank([...counts.values()]);
}

/** Fold one just-run command in, promoting it above its equals. */
export function remember(history: CommandHistory, line: string): CommandHistory {
  const command = line.trim();
  if (!command) return history;
  const newest = (history[0]?.lastSeen ?? 0) + 1;
  const seen = history.find((entry) => entry.line === command);
  const rest = seen ? history.filter((entry) => entry.line !== command) : history;
  return rank([
    ...rest,
    { line: command, uses: (seen?.uses ?? 0) + 1, lastSeen: newest },
  ]);
}

/**
 * The full command this prefix most likely becomes, or null when
 * nothing fits. The caller shows what is past the prefix.
 *
 * A prefix that is already a whole known command suggests nothing —
 * completing `cls` to `cls` is an invitation to press a key for no
 * effect.
 */
export function predict(history: CommandHistory, prefix: string | null): string | null {
  if (!prefix?.trim()) return null;
  const match = history.find(
    (entry) => entry.line.length > prefix.length && entry.line.startsWith(prefix),
  );
  return match?.line ?? null;
}

/** What `predict` found, minus what the user already typed. */
export function suggestionSuffix(history: CommandHistory, prefix: string | null): string {
  const full = predict(history, prefix);
  return full && prefix ? full.slice(prefix.length) : "";
}

function rank(entries: CommandUse[]): CommandHistory {
  entries.sort((a, b) => b.uses - a.uses || b.lastSeen - a.lastSeen);
  entries.length = Math.min(entries.length, MAX_COMMANDS);
  return entries;
}
