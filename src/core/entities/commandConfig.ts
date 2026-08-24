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
  /**
   * Model to run this command under (empty means the provider default).
   *
   * The cost lever: mechanical commands — a commit message, a changelog,
   * a rename — do not need the model a hard debugging session needs, and
   * pinning a cheap one here is the difference between choosing that once
   * and remembering to choose it every time.
   */
  readonly model?: string;
  /**
   * Hand the command off to this sub-agent instead of running it in the
   * chat (empty or absent means run it here).
   *
   * This is the setting that makes the two above work. Model and effort
   * are spawn-time, so ApplyCommandConfig has to skip them once a
   * conversation exists — but a sub-agent is a fresh child, so whatever
   * its definition pins applies with nothing to re-ingest. It is also
   * where the saving actually is: the child's tool output never enters
   * this conversation, so the turns that follow stop paying to re-read
   * it.
   */
  readonly agent?: string;
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
  return (
    !config?.mode &&
    !config?.permission &&
    !config?.effort &&
    !config?.model &&
    !config?.agent
  );
}
