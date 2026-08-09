import type { ProviderId } from "../entities/provider";

/**
 * Ports layer — "can this agent actually work right now?".
 *
 * Owned by the core so the settings screen can answer the question
 * without knowing that the answer comes from launching a CLI.
 */

/**
 * How ready a provider is, worst to best.
 *
 * `started` exists because the handshake cannot prove sign-in: the Claude
 * adapter opens a session without touching credentials and only
 * authenticates on the first prompt. Reporting that as "ready" is what
 * made an expired login look like a working setup right up until the
 * user sent a message.
 */
export type Readiness = "notInstalled" | "signInRequired" | "started" | "ready";

export interface ProviderStatus {
  readonly provider: ProviderId;
  readonly readiness: Readiness;
  /** What to show the user: the agent's own words where there are any. */
  readonly detail: string;
  /** How to install it, when it isn't installed. */
  readonly installHint: string;
  /** The sign-in command as a user would type it, when one is known. */
  readonly signInCommand: string;
}

export interface ProviderProbe {
  probe(provider: ProviderId, projectPath: string): Promise<ProviderStatus>;
  /**
   * Put the user in front of the provider's own login prompt. The app
   * never handles credentials — the vendor's CLI owns its token store.
   */
  signIn(provider: ProviderId): Promise<void>;
}
