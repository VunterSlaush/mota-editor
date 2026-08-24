import { CLEAR_COMMAND } from "./command";
import type { CommandConfig } from "./commandConfig";
import { commandConfigKey } from "./commandConfig";
import { CREATE_EXTENSION_COMMAND } from "./createExtensionGuide";
import { COMPACT_COMMAND, type ProviderId } from "./provider";

/**
 * Entities layer — a sub-agent a slash command can be handed off to.
 *
 * Every provider ships the same idea under its own name: a child agent
 * with its own context window, its own system prompt, and optionally its
 * own model. Mota does not implement one — it points at the ones the
 * provider and the user already have, which is why nothing here writes
 * anything: `source` says where a definition was found, and that is all
 * the domain needs to know about disk.
 */
export type SubagentSource = "builtin" | "project" | "user";

export interface SubagentInfo {
  readonly name: string;
  readonly description: string;
  readonly source: SubagentSource;
}

/**
 * The agents each provider ships with. Static domain data, like
 * `BUILTIN_COMMANDS` — they exist whether or not the user ever wrote a
 * definition file, so discovery must not be what makes them appear.
 * (Verified against each vendor's docs, 2026-08.)
 */
export const BUILTIN_SUBAGENTS: Readonly<Record<ProviderId, readonly SubagentInfo[]>> = {
  claude: [
    {
      name: "general-purpose",
      description: "Researches complex questions and runs multi-step tasks",
      source: "builtin",
    },
    {
      name: "Explore",
      description: "Fast read-only search across the codebase",
      source: "builtin",
    },
    {
      name: "Plan",
      description: "Designs an implementation plan without editing",
      source: "builtin",
    },
  ],
  codex: [
    { name: "default", description: "General-purpose fallback agent", source: "builtin" },
    {
      name: "worker",
      description: "Execution-focused agent for implementation and fixes",
      source: "builtin",
    },
    {
      name: "explorer",
      description: "Read-heavy codebase exploration agent",
      source: "builtin",
    },
  ],
  gemini: [
    {
      name: "generalist",
      description: "General-purpose agent for multi-step, resource-heavy tasks",
      source: "builtin",
    },
    {
      name: "codebase_investigator",
      description: "Analyses the codebase and its dependencies",
      source: "builtin",
    },
  ],
};

/**
 * Commands that must never be handed off, whatever the settings say.
 *
 * The first two are Mota's own and never reach an agent at all. The
 * third is the real trap: `SendPrompt.autoCompactIfNeeded` compacts by
 * sending `COMPACT_COMMAND` as an ordinary turn, and compaction only
 * means anything to the session that is actually full — delegated, it
 * would run in a child with an empty context and quietly free nothing
 * while the tab kept growing.
 */
export function isNeverDelegated(provider: ProviderId, command: string): boolean {
  return (
    command === CLEAR_COMMAND ||
    command === CREATE_EXTENSION_COMMAND ||
    command === COMPACT_COMMAND[provider]
  );
}

/**
 * Names every provider's mention grammar accepts. Claude's is the
 * narrowest — its expander matches `@"<name> (agent)"` against
 * `[\w:.@-]+` — so a name outside this set cannot be addressed at all,
 * and a mention that fails to resolve is dropped SILENTLY, leaving the
 * command to run inline at full price. Anything unaddressable is
 * therefore refused up front rather than sent and hoped for.
 */
const ADDRESSABLE = /^[\w:.@-]+$/;

export function isAddressableSubagent(name: string): boolean {
  return ADDRESSABLE.test(name);
}

/**
 * The sub-agent a prompt's leading command should be handed off to, or
 * null to run it in the chat as usual. The single decision point: the
 * config carries a name, the command is eligible, and the name is one a
 * provider could actually address.
 */
export function delegatedSubagent(
  configs: Readonly<Record<string, CommandConfig>>,
  provider: ProviderId,
  command: string | null,
): string | null {
  if (!command || isNeverDelegated(provider, command)) return null;
  const agent = configs[commandConfigKey(provider, command)]?.agent;
  if (!agent || !isAddressableSubagent(agent)) return null;
  return agent;
}

/** Whether a discovered or built-in agent by this name exists. */
export function subagentExists(agents: readonly SubagentInfo[], name: string): boolean {
  return agents.some((a) => a.name === name);
}

/**
 * One entry per name, first occurrence winning — the same rule as
 * `dedupeCommands`. Built-ins are listed first, then project, then user,
 * so a project definition shadows a personal one of the same name and
 * neither can displace a name the provider reserves.
 */
export function dedupeSubagents(agents: readonly SubagentInfo[]): SubagentInfo[] {
  const seen = new Set<string>();
  return agents.filter((a) => {
    if (seen.has(a.name)) return false;
    seen.add(a.name);
    return true;
  });
}
