import type { ProviderId } from "./provider";

/**
 * Entities layer — a slash command the user can send to an agent.
 */
/** Where a command comes from: the CLI itself, the project's command
 *  folder, the user's home command folder, or an installed extension. */
export type CommandSource = "builtin" | "project" | "user" | "extension";

export interface CommandInfo {
  readonly name: string;
  readonly description: string;
  readonly source: CommandSource;
  /** Which extension contributed it, for `source: "extension"`. */
  readonly extensionId?: string;
}

/**
 * Built-in commands each CLI understands in headless mode. Custom
 * commands (project/user command folders) are discovered at runtime and
 * merged by the ListCommands use case.
 */
export const BUILTIN_COMMANDS: Readonly<Record<ProviderId, readonly CommandInfo[]>> = {
  claude: [
    {
      name: "/init",
      description: "Create or refresh CLAUDE.md with project guidance",
      source: "builtin",
    },
    {
      name: "/review",
      description: "Review current changes or a pull request",
      source: "builtin",
    },
    {
      name: "/compact",
      description: "Summarize the conversation to free context",
      source: "builtin",
    },
  ],
  codex: [
    {
      name: "/init",
      description: "Create AGENTS.md with project guidance",
      source: "builtin",
    },
    { name: "/review", description: "Review current changes", source: "builtin" },
  ],
  gemini: [],
};

/**
 * One entry per name, first occurrence wins. An agent may advertise the
 * same name from several sources (a command file, a same-named skill, a
 * plugin) — the palette must not show it once per source.
 */
export function dedupeCommands(commands: readonly CommandInfo[]): CommandInfo[] {
  const seen = new Set<string>();
  return commands.filter((c) => {
    if (seen.has(c.name)) return false;
    seen.add(c.name);
    return true;
  });
}

/** Commands whose names start with the typed prefix (case-insensitive). */
export function filterCommands(
  commands: readonly CommandInfo[],
  typed: string,
): CommandInfo[] {
  const prefix = typed.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(prefix));
}

/** A run of prompt text, flagged when it names a command. */
export interface TextSegment {
  readonly text: string;
  readonly command: boolean;
}

/** The command names, lowercased, ready for `splitCommands`. */
export function commandNames(commands: readonly CommandInfo[]): ReadonlySet<string> {
  return new Set(commands.map((c) => c.name.toLowerCase()));
}

/**
 * Split prompt text so every token that names a real command becomes its
 * own segment, ready to be highlighted.
 *
 * Matching is against the known command list rather than "anything
 * starting with a slash": a prompt is full of paths and URLs, and
 * lighting up `/usr/bin/env` or the `/blob/main` inside a link would be
 * noise. Whitespace is the only delimiter, so a trailing comma keeps the
 * token from matching — which is right, since the agent wouldn't treat
 * `/review,` as a command either.
 */
export function splitCommands(
  text: string,
  names: ReadonlySet<string>,
): readonly TextSegment[] {
  if (text === "" || names.size === 0) return [{ text, command: false }];

  const segments: TextSegment[] = [];
  let plain = "";
  // Keep the separators: the segments must rebuild the text exactly.
  for (const token of text.split(/(\s+)/)) {
    if (token !== "" && names.has(token.toLowerCase())) {
      if (plain !== "") {
        segments.push({ text: plain, command: false });
        plain = "";
      }
      segments.push({ text: token, command: true });
    } else {
      plain += token;
    }
  }
  if (plain !== "") segments.push({ text: plain, command: false });
  return segments;
}
