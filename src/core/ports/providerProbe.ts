import type { ProviderId } from "../entities/provider";

/**
 * Ports layer — "can this agent actually work right now?".
 *
 * Owned by the core so the settings screen can answer the question
 * without knowing that the answer comes from launching a CLI.
 */
export interface ProviderStatus {
  readonly provider: ProviderId;
  /** The agent launched and spoke the protocol. */
  readonly installed: boolean;
  /** It also opened a session — the real proof it can do work. */
  readonly authenticated: boolean;
  /** What to show the user: the agent's own words where there are any. */
  readonly detail: string;
  /** How to install it, when it isn't installed. */
  readonly installHint: string;
}

export interface ProviderProbe {
  probe(provider: ProviderId, projectPath: string): Promise<ProviderStatus>;
}
