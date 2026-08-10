import { invoke } from "@tauri-apps/api/core";
import type { ProvisionEntry } from "../../core/entities/worktree";
import type {
  DiskUsage,
  ProvisionReport,
  WorktreeProvisioning,
} from "../../core/ports/worktreeProvisioning";

/** Interface adapter — worktree provisioning via the Rust backend. */
export class TauriWorktreeProvisioning implements WorktreeProvisioning {
  async provision(
    mainPath: string,
    worktreePath: string,
    entries: readonly ProvisionEntry[],
  ): Promise<ProvisionReport> {
    return invoke<ProvisionReport>("worktree_provision", {
      args: { mainPath, worktreePath, entries: [...entries] },
    });
  }

  async unprovision(worktreePath: string, paths: readonly string[]): Promise<string[]> {
    return invoke<string[]>("worktree_unprovision", {
      worktreePath,
      paths: [...paths],
    });
  }

  async supportsCow(path: string): Promise<boolean> {
    return invoke<boolean>("worktree_supports_cow", { path });
  }

  async folderCandidates(projectPath: string): Promise<string[]> {
    return invoke<string[]>("worktree_folder_candidates", { projectPath });
  }

  async diskUsage(
    worktreePath: string,
    sharedPaths: readonly string[],
  ): Promise<DiskUsage> {
    return invoke<DiskUsage>("worktree_disk_usage", {
      args: { worktreePath, sharedPaths: [...sharedPaths] },
    });
  }
}
