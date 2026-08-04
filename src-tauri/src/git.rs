//! Git command handlers — thin controllers over the `git` CLI.
//! Output parsing is pure and lives in `agent_core::vcs`.

use agent_core::vcs::{self, Branch, Commit, GitChange};

use crate::runner;

/// Run git in the project folder; never prompts for credentials
/// (GIT_TERMINAL_PROMPT=0 makes auth problems fail fast instead of
/// hanging a UI that has no terminal to answer in).
async fn run_git(project_path: &str, args: &[&str]) -> Result<String, String> {
    let mut full_args = vec!["-C".to_owned(), project_path.to_owned()];
    full_args.extend(args.iter().map(|a| (*a).to_owned()));

    let output = runner::os_command("git", &full_args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .map_err(|e| format!("Could not run git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        Ok(stdout)
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr);
        Err(tail(stderr.trim(), 4))
    }
}

/// The last lines of git's error output — the part users act on.
fn tail(text: &str, lines: usize) -> String {
    if text.is_empty() {
        return "git failed without an error message.".to_owned();
    }
    let all: Vec<&str> = text.lines().collect();
    all[all.len().saturating_sub(lines)..].join("\n")
}

#[tauri::command]
pub async fn git_status(project_path: String) -> Result<Vec<GitChange>, String> {
    let out = run_git(&project_path, &["status", "--porcelain"]).await?;
    Ok(vcs::parse_status(&out))
}

#[tauri::command]
pub async fn git_log(project_path: String, limit: u32) -> Result<Vec<Commit>, String> {
    let count = format!("-n{}", limit.clamp(1, 100));
    let out = run_git(
        &project_path,
        &["log", &count, "--pretty=format:%h%x09%s%x09%an%x09%ar"],
    )
    .await
    .unwrap_or_default(); // empty repo: no commits is not an error
    Ok(vcs::parse_log(&out))
}

#[tauri::command]
pub async fn git_stage(project_path: String, path: String) -> Result<(), String> {
    run_git(&project_path, &["add", "--", &path]).await.map(|_| ())
}

#[tauri::command]
pub async fn git_unstage(project_path: String, path: String) -> Result<(), String> {
    run_git(&project_path, &["restore", "--staged", "--", &path])
        .await
        .map(|_| ())
}

#[tauri::command]
pub async fn git_commit(project_path: String, message: String) -> Result<String, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("A commit message is required.".to_owned());
    }
    run_git(&project_path, &["commit", "-m", trimmed]).await.map(summary)
}

#[tauri::command]
pub async fn git_branches(project_path: String) -> Result<Vec<Branch>, String> {
    let out = run_git(
        &project_path,
        &["branch", "--format=%(HEAD)%09%(refname:short)"],
    )
    .await?;
    Ok(vcs::parse_branches(&out))
}

#[tauri::command]
pub async fn git_checkout(project_path: String, branch: String) -> Result<String, String> {
    run_git(&project_path, &["checkout", &branch]).await.map(summary)
}

#[tauri::command]
pub async fn git_push(project_path: String) -> Result<String, String> {
    run_git(&project_path, &["push"]).await.map(summary)
}

#[tauri::command]
pub async fn git_pull(project_path: String) -> Result<String, String> {
    run_git(&project_path, &["pull", "--ff-only"]).await.map(summary)
}

fn summary(output: String) -> String {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        "Done.".to_owned()
    } else {
        tail(trimmed, 2)
    }
}
