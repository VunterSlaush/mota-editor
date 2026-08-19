import type { ProviderId } from "../entities/provider";

/**
 * Ports layer — asking an agent to name a project's areas.
 *
 * Its own port rather than a method on `AgentGateway`: this is not a
 * turn in anyone's conversation. The implementation asks a throwaway
 * read-only agent one question and throws the session away, so nothing
 * here belongs to a tab (ADR-0014).
 *
 * It spends the user's tokens, so every caller is a button they pressed.
 */
export interface BoundarySuggestions {
  /**
   * Groups of folders an agent thinks are this project's areas, each
   * with a name a person would recognise. Rejects rather than resolves
   * empty when the agent is unavailable or answered unusably — the
   * caller shows that message instead of an empty list.
   */
  suggest(
    provider: ProviderId,
    projectPath: string,
    folders: readonly string[],
  ): Promise<{ name: string; boundaries: string[] }[]>;
}
