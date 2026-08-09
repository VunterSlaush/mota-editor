import type { BilledRequest } from "../entities/billing";

/**
 * Ports layer — read-only access to what a vendor actually billed.
 *
 * Mota never calls an LLM API, so it cannot observe billing directly;
 * the vendor CLIs write it to their own session logs. This port reads
 * those logs and nothing else — it is the only source of exact cost in
 * the app, and it is optional by design: implementations return an empty
 * list for sessions they know nothing about (a provider with no readable
 * log, a session that predates the id being recorded), and callers fall
 * back to the estimate rather than showing a gap.
 *
 * Implementations must return only token counts. These logs contain the
 * full text of every conversation, which has no business crossing this
 * boundary.
 */
export interface BillingStore {
  /**
   * Billed requests for the given PROVIDER session ids (a transcript's
   * `providerSessionId`, not its local `id`), deduplicated per request.
   */
  readBilledUsage(sessionIds: readonly string[]): Promise<BilledRequest[]>;
}
