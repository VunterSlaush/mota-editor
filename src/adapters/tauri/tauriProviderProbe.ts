import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "../../core/entities/provider";
import type {
  ProviderProbe,
  ProviderStatus,
  Readiness,
} from "../../core/ports/providerProbe";

/** Wire shape returned by the Rust backend (`probe_provider`). */
interface WireStatus {
  provider: string;
  readiness: Readiness;
  detail: string;
  installHint: string;
  signInCommand: string;
}

/**
 * Interface adapter — asks the backend to run a short ACP handshake with
 * the provider's agent and reports what it found.
 */
export class TauriProviderProbe implements ProviderProbe {
  async probe(provider: ProviderId, projectPath: string): Promise<ProviderStatus> {
    const wire = await invoke<WireStatus>("probe_provider", {
      providerId: provider,
      projectPath,
    });
    return { ...wire, provider };
  }

  async signIn(provider: ProviderId): Promise<void> {
    await invoke("open_provider_login", { providerId: provider });
  }
}
