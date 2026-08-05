import type { AgentMode, PermissionPolicy } from "./agentSettings";
import type { ProviderId } from "./provider";

/**
 * Entities layer — settings a slash command carries with it.
 *
 * Some commands only make sense under a particular setup: a review reads
 * best in plan mode at high effort, a formatting command wants neither.
 * Attaching that to the command means the user stops re-setting the
 * toolbar by hand every time they run it.
 */
export interface CommandConfig {
  readonly mode?: AgentMode;
  readonly permission?: PermissionPolicy;
  readonly effort?: string;
}

/**
 * Keyed by provider AND name: `/review` exists for both Claude and Codex
 * and the two shouldn't share a setting.
 */
export function commandConfigKey(provider: ProviderId, name: string): string {
  return `${provider}:${name}`;
}

/**
 * The slash command a prompt invokes, or null when it is ordinary prose.
 * Only a LEADING token counts — "what does /review do?" is a question
 * about the command, not a use of it.
 */
export function leadingCommand(prompt: string): string | null {
  const first = prompt.trim().split(/\s+/)[0] ?? "";
  return first.length > 1 && first.startsWith("/") ? first : null;
}

/** Whether a config would actually change anything. */
export function isEmptyCommandConfig(config: CommandConfig | undefined): boolean {
  return !config?.mode && !config?.permission && !config?.effort;
}
