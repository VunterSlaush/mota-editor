import {
  CREATE_EXTENSION_COMMAND,
  CREATE_EXTENSION_DESCRIPTION,
} from "./createExtensionGuide";
import {
  INSTALL_EXTENSION_COMMAND,
  INSTALL_EXTENSION_DESCRIPTION,
} from "./installExtensionGuide";
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
 * Mota's own command, available with every provider: it never reaches
 * the agent as a slash command — SendPrompt expands it into the full
 * scaffolding brief (`createExtensionPrompt`) client-side.
 */
const CREATE_EXTENSION: CommandInfo = {
  name: CREATE_EXTENSION_COMMAND,
  description: CREATE_EXTENSION_DESCRIPTION,
  source: "builtin",
};

/** Its other half, and Mota's own for the same reason: installing is
 *  copying a folder into `~/.mota/extensions/`, which the agent can do —
 *  approving it is a native dialog, which only the user can. */
const INSTALL_EXTENSION: CommandInfo = {
  name: INSTALL_EXTENSION_COMMAND,
  description: INSTALL_EXTENSION_DESCRIPTION,
  source: "builtin",
};

/**
 * Start a fresh conversation. Mota's own too, and for the same reason:
 * clearing is something the app does to itself. Sending it on would ask
 * the agent to clear a session that is about to be ended anyway, and the
 * providers that have no such command would take it for a prompt.
 */
export const CLEAR_COMMAND = "/clear";

const CLEAR: CommandInfo = {
  name: CLEAR_COMMAND,
  description: "Start a new chat — the current one stays in History",
  source: "builtin",
};

/**
 * Mota's own, in the order they are offered. None of the three reaches an
 * agent as a slash command, so no agent can advertise them and nothing
 * else can supply them — which is exactly why `paletteCommands` keeps
 * them whatever the running session says.
 */
export const MOTA_COMMANDS: readonly CommandInfo[] = [
  CREATE_EXTENSION,
  INSTALL_EXTENSION,
  CLEAR,
];

/**
 * Built-in commands each CLI understands in headless mode (plus Mota's
 * own, above). Custom commands (project/user command folders) are
 * discovered at runtime and merged by the ListCommands use case.
 */
export const BUILTIN_COMMANDS: Readonly<Record<ProviderId, readonly CommandInfo[]>> = {
  claude: [
    CREATE_EXTENSION,
    INSTALL_EXTENSION,
    CLEAR,
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
    CREATE_EXTENSION,
    INSTALL_EXTENSION,
    CLEAR,
    {
      name: "/init",
      description: "Create AGENTS.md with project guidance",
      source: "builtin",
    },
    { name: "/review", description: "Review current changes", source: "builtin" },
  ],
  gemini: [CREATE_EXTENSION, INSTALL_EXTENSION, CLEAR],
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

/**
 * The palette's list once a session is live: what the running agent
 * advertises, plus everything the agent cannot know about.
 *
 * A live ACP session reports the CLI's real commands, which beats the
 * static per-provider table — but it used to REPLACE the whole list, and
 * with it Mota's own commands, every installed extension's commands and
 * every custom command file. They were still typeable and completely
 * undiscoverable. So the agent's list supersedes only the static builtins
 * it is a better version of; Mota's own go first because nothing else can
 * offer them, and extension and file commands keep their place.
 *
 * Alphabetical, like `ListCommands`, so the palette does not reorder
 * itself the moment a session comes up.
 */
export function paletteCommands(
  agentCommands: readonly CommandInfo[],
  discovered: readonly CommandInfo[],
): CommandInfo[] {
  if (agentCommands.length === 0) return [...discovered];
  const own = new Set(MOTA_COMMANDS.map((c) => c.name));
  return dedupeCommands([
    ...MOTA_COMMANDS,
    ...agentCommands,
    // Whatever is left is something the agent could not have advertised:
    // extension contributions and command files. Its own stale builtins
    // are dropped — the live list is the true one.
    ...discovered.filter((c) => c.source !== "builtin" && !own.has(c.name)),
  ]).sort((a, b) => a.name.localeCompare(b.name));
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
