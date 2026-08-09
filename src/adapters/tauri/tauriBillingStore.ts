import { invoke } from "@tauri-apps/api/core";
import type { BilledRequest } from "../../core/entities/billing";
import type { BillingStore } from "../../core/ports/billingStore";

/** The Rust command's payload, before it is narrowed to the domain type. */
interface WireBilledRequest {
  requestId: string;
  sessionId: string;
  timestampMs: number;
  model: string;
  isSidechain: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheWrite5mTokens: number;
  cacheWrite1hTokens: number;
  cacheReadTokens: number;
}

/** Interface adapter — billed usage read from vendor session logs. */
export class TauriBillingStore implements BillingStore {
  async readBilledUsage(sessionIds: readonly string[]): Promise<BilledRequest[]> {
    if (sessionIds.length === 0) return [];
    // Never load-bearing: Insights must still render when the vendor's
    // log is missing, unreadable, or in a shape we don't know.
    const wire = await invoke<WireBilledRequest[]>("read_billed_usage", {
      sessionIds: [...sessionIds],
    }).catch(() => []);
    return wire.map(toBilledRequest);
  }
}

function toBilledRequest(wire: WireBilledRequest): BilledRequest {
  return { ...wire };
}
