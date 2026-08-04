import { invoke } from "@tauri-apps/api/core";
import type { GitBranch, GitChange, GitCommit, GitPort } from "../../core/ports/gitPort";

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
}
