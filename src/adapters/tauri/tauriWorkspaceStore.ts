import { invoke } from "@tauri-apps/api/core";
import type { PersistedWorkspace, WorkspaceStore } from "../../core/ports/workspacePort";

/**
 * Interface adapter — persists the workspace via the Tauri backend,
 * which writes JSON into the OS-appropriate app-config directory.
 */
export class TauriWorkspaceStore implements WorkspaceStore {
  async load(): Promise<PersistedWorkspace | null> {
    const raw = await invoke<string | null>("load_workspace");
    if (!raw) return null;
    try {
      return JSON.parse(raw) as PersistedWorkspace;
    } catch {
      return null;
    }
  }

  async save(workspace: PersistedWorkspace): Promise<void> {
    await invoke("save_workspace", { json: JSON.stringify(workspace) });
  }
}
