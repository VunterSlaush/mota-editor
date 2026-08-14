import { invoke } from "@tauri-apps/api/core";
import type {
  GitBranch,
  GitChange,
  GitCommit,
  GitDivergence,
  GitPort,
  GitWorktree,
  WorktreeAddMode,
  WorktreeRemoveMode,
} from "../../core/ports/gitPort";

/** Interface adapter — git operations via the Rust backend. */
export class TauriGitStatus implements GitPort {
  async changes(projectPath: string): Promise<GitChange[]> {
    return invoke<GitChange[]>("git_status", { projectPath });
  }

  async log(projectPath: string, limit: number): Promise<GitCommit[]> {
    return invoke<GitCommit[]>("git_log", { projectPath, limit });
  }

  async branches(projectPath: string): Promise<GitBranch[]> {
    return invoke<GitBranch[]>("git_branches", { projectPath });
  }

  async remoteUrl(projectPath: string): Promise<string> {
    return invoke<string>("git_remote_url", { projectPath });
  }

  async currentBranch(projectPath: string): Promise<string> {
    return invoke<string>("git_current_branch", { projectPath });
  }

  async upstream(projectPath: string): Promise<GitDivergence | null> {
    return invoke<GitDivergence | null>("git_upstream", { projectPath });
  }

  async listFiles(projectPath: string): Promise<string[]> {
    return invoke<string[]>("git_list_files", { projectPath });
  }

  async diff(
    projectPath: string,
    path: string,
    staged: boolean,
    untracked: boolean,
  ): Promise<string> {
    return invoke<string>("git_diff", { projectPath, path, staged, untracked });
  }

  async commit(projectPath: string, message: string): Promise<string> {
    return invoke<string>("git_commit", { projectPath, message });
  }

  async checkout(projectPath: string, branch: string): Promise<string> {
    return invoke<string>("git_checkout", { projectPath, branch });
  }

  async stage(projectPath: string, path: string): Promise<void> {
    await invoke("git_stage", { projectPath, path });
  }

  async unstage(projectPath: string, path: string): Promise<void> {
    await invoke("git_unstage", { projectPath, path });
  }

  async push(projectPath: string): Promise<string> {
    return invoke<string>("git_push", { projectPath });
  }

  async pull(projectPath: string): Promise<string> {
    return invoke<string>("git_pull", { projectPath });
  }

  async fetch(projectPath: string): Promise<string> {
    return invoke<string>("git_fetch", { projectPath });
  }

  async worktrees(projectPath: string): Promise<GitWorktree[]> {
    return invoke<GitWorktree[]>("git_worktree_list", { projectPath });
  }

  async worktreeAdd(
    projectPath: string,
    worktreePath: string,
    branch: string,
    mode: WorktreeAddMode,
    remote: string,
    base: string,
  ): Promise<string> {
    return invoke<string>("git_worktree_add", {
      projectPath,
      worktreePath,
      branch,
      mode,
      remote,
      base,
    });
  }

  async worktreeRemove(
    projectPath: string,
    worktreePath: string,
    mode: WorktreeRemoveMode,
  ): Promise<string> {
    return invoke<string>("git_worktree_remove", { projectPath, worktreePath, mode });
  }

  async worktreePrune(projectPath: string): Promise<string> {
    return invoke<string>("git_worktree_prune", { projectPath });
  }

  async branchesMerged(projectPath: string, base: string): Promise<GitBranch[]> {
    return invoke<GitBranch[]>("git_branches_merged", { projectPath, base });
  }
}
