import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "../../core/entities/provider";
import type { SubagentInfo } from "../../core/entities/subagent";
import type { AgentCatalog } from "../../core/ports/agentCatalog";

/** Wire shape returned by the Rust backend (`list_subagents`). */
interface WireAgent {
  name: string;
  description: string;
  origin: "project" | "user";
}

/**
 * Interface adapter — discovers sub-agents by asking the backend to scan
 * the provider's agent folders.
 */
export class TauriAgentCatalog implements AgentCatalog {
  async listSubagents(
    projectPath: string,
    provider: ProviderId,
  ): Promise<SubagentInfo[]> {
    const wire = await invoke<WireAgent[]>("list_subagents", {
      projectPath,
      providerId: provider,
    });
    return wire.map(({ name, description, origin }) => ({
      name,
      description,
      source: origin ?? "user",
    }));
  }
}
