import { invoke } from "@tauri-apps/api/core";
import type { CheckpointPort, CheckpointPreview } from "../../core/ports/checkpointPort";

/** Interface adapter — `/rewind` snapshots via the Rust backend. */
export class TauriCheckpoints implements CheckpointPort {
  async available(projectPath: string): Promise<boolean> {
    return invoke<boolean>("checkpoint_available", { projectPath });
  }

  async create(projectPath: string, sessionId: string): Promise<string> {
    return invoke<string>("checkpoint_create", { projectPath, sessionId });
  }

  async preview(projectPath: string, checkpoint: string): Promise<CheckpointPreview> {
    return invoke<CheckpointPreview>("checkpoint_preview", {
      projectPath,
      commit: checkpoint,
    });
  }

  async restore(projectPath: string, checkpoint: string): Promise<string[]> {
    return invoke<string[]>("checkpoint_restore", {
      projectPath,
      commit: checkpoint,
    });
  }

  async fileDiff(projectPath: string, checkpoint: string, path: string): Promise<string> {
    return invoke<string>("checkpoint_file_diff", {
      projectPath,
      commit: checkpoint,
      path,
    });
  }

  async forget(projectPath: string, sessionId: string): Promise<void> {
    await invoke<void>("checkpoint_forget", { projectPath, sessionId });
  }
}
