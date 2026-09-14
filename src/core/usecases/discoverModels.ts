import type { ProviderId } from "../entities/provider";
import type { ProviderProbe, ProviderStatus } from "../ports/providerProbe";
import type { Store } from "../state/store";

/** Discover Codex choices through the existing readiness handshake, once per app run. */
export class DiscoverModels {
  private pending: Promise<void> | undefined;

  constructor(
    private readonly store: Store,
    private readonly probe: ProviderProbe,
  ) {}

  async execute(provider: ProviderId, projectPath: string): Promise<void> {
    if (provider !== "codex" || this.store.getState().modelCatalogs?.codex) return;
    if (this.pending) return this.pending;
    this.pending = this.recheck(provider, projectPath).then(
      () => undefined,
      () => undefined,
    );
    try {
      await this.pending;
    } finally {
      this.pending = undefined;
    }
  }

  /** Explicit connection checks refresh the catalog after login or account changes. */
  async recheck(provider: ProviderId, projectPath: string): Promise<ProviderStatus> {
    try {
      const status = await this.probe.probe(provider, projectPath);
      if (provider === "codex") {
        this.store.dispatch({
          type: "provider/modelsDiscovered",
          provider,
          catalog: status.catalog?.models.length ? status.catalog : undefined,
          problem: status.catalog?.models.length
            ? undefined
            : `Could not load Codex models. ${status.detail}`,
        });
      }
      return status;
    } catch (error) {
      if (provider === "codex")
        this.store.dispatch({
          type: "provider/modelsDiscovered",
          provider,
          problem: `Could not load Codex models: ${String(error)}`,
        });
      throw error;
    }
  }
}
