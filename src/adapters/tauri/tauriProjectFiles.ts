import { invoke } from "@tauri-apps/api/core";
import type { ProjectFiles } from "../../core/ports/projectFiles";

/** Interface adapter — the disk walk behind the Rust backend. */
export class TauriProjectFiles implements ProjectFiles {
  async walk(projectPath: string): Promise<string[]> {
    return invoke<string[]>("list_folder_files", { projectPath });
  }
}
