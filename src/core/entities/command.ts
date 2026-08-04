import type { ProviderId } from "./provider";

/**
 * Entities layer — a slash command the user can send to an agent.
 */
export interface CommandInfo {
  readonly name: string;
  readonly description: string;
  readonly source: "builtin" | "custom";
}

/**
 * Built-in commands each CLI understands in headless mode. Custom
 * commands (project/user command folders) are discovered at runtime and
 * merged by the ListCommands use case.
 */
export const BUILTIN_COMMANDS: Readonly<Record<ProviderId, readonly CommandInfo[]>> = {
  claude: [
    { name: "/init", description: "Create or refresh CLAUDE.md with project guidance", source: "builtin" },
    { name: "/review", description: "Review current changes or a pull request", source: "builtin" },
    { name: "/compact", description: "Summarize the conversation to free context", source: "builtin" },
  ],
  codex: [
    { name: "/init", description: "Create AGENTS.md with project guidance", source: "builtin" },
    { name: "/review", description: "Review current changes", source: "builtin" },
  ],
  gemini: [],
};

/** Commands whose names start with the typed prefix (case-insensitive). */
export function filterCommands(
  commands: readonly CommandInfo[],
  typed: string,
): CommandInfo[] {
  const prefix = typed.toLowerCase();
  return commands.filter((c) => c.name.toLowerCase().startsWith(prefix));
}
