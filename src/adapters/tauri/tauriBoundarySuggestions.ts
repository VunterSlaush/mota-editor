import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "../../core/entities/provider";
import type { BoundarySuggestions } from "../../core/ports/boundarySuggestions";

/**
 * Interface adapter — one agent question, asked over the Rust backend's
 * throwaway session (`suggest_boundaries`). The backend does the wire
 * work and the parsing; a failure arrives as its message.
 */
export class TauriBoundarySuggestions implements BoundarySuggestions {
  async suggest(
    provider: ProviderId,
    projectPath: string,
    folders: readonly string[],
  ): Promise<{ name: string; boundaries: string[] }[]> {
    return invoke<{ name: string; boundaries: string[] }[]>("suggest_boundaries", {
      providerId: provider,
      projectPath,
      folders: [...folders],
    });
  }
}
