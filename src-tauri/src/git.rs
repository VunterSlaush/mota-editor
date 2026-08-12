//! Git command handlers — thin controllers over the `git` CLI.
//! Output parsing is pure and lives in `agent_core::vcs`.

use agent_core::vcs::{self, Branch, Commit, Divergence, GitChange, Worktree};
use agent_core::worktree;

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
        Err(vcs::explain_failure(stderr.trim()))
    }
}

/// Like `run_git`, but a diff that found differences (exit code 1) is a
/// success, not a failure. Only `git diff --no-index` reports that way.
async fn run_git_diff(project_path: &str, args: &[&str]) -> Result<String, String> {
    let mut full_args = vec!["-C".to_owned(), project_path.to_owned()];
    full_args.extend(args.iter().map(|a| (*a).to_owned()));

    let output = runner::os_command("git", &full_args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .await
        .map_err(|e| format!("Could not run git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    match output.status.code() {
        Some(0) | Some(1) => Ok(stdout),
        _ => {
            let stderr = String::from_utf8_lossy(&output.stderr);
            Err(vcs::explain_failure(stderr.trim()))
        }
    }
}

/// The last lines of git's output — for a success, where the useful
/// part (what a pull brought down) is at the end. Failures go through
/// `vcs::explain_failure` instead, which leads with the reason.
fn tail(text: &str, lines: usize) -> String {
    if text.is_empty() {
        return "git said nothing.".to_owned();
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

/// The push/pull remote's URL, for linking a commit to its forge. An
/// empty string when the repo has no `origin` — a normal state, not an
/// error, so the UI can simply not offer the link.
#[tauri::command]
pub async fn git_remote_url(project_path: String) -> Result<String, String> {
    let out = run_git(&project_path, &["config", "--get", "remote.origin.url"])
        .await
        .unwrap_or_default(); // exits 1 when the key is unset
    Ok(out.trim().to_owned())
}

/// The branch this checkout is on, for the tab strip.
///
/// One process against `.git/HEAD`, rather than the five calls the
/// Changes panel makes: this is asked for every open project, including
/// the ones the user has not looked at yet, so it has to stay the
/// cheapest question we know how to ask git. Empty for a detached HEAD,
/// a repository with no commits, or a folder that is not a repository —
/// all normal, none of them worth an error the tab strip cannot show.
#[tauri::command]
pub async fn git_current_branch(project_path: String) -> Result<String, String> {
    let out = run_git(&project_path, &["branch", "--show-current"])
        .await
        .unwrap_or_default();
    Ok(out.trim().to_owned())
}

/// Every file git knows about — tracked plus untracked-and-not-ignored,
/// which is the file the agent just wrote — for the composer's "@" menu.
/// A folder that is not a repository yields an empty menu, not an error.
#[tauri::command]
pub async fn git_list_files(project_path: String) -> Result<Vec<String>, String> {
    // -z is load-bearing: without it git quotes and octal-escapes any
    // path with a space or a non-ASCII character.
    let out = run_git(
        &project_path,
        &["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
    )
    .await
    .unwrap_or_default();
    Ok(vcs::parse_ls_files(&out))
}

/// A unified diff for one file. Untracked files have nothing to diff
/// against, so they are compared with the null device instead, which
/// renders the whole file as added.
#[tauri::command]
pub async fn git_diff(
    project_path: String,
    path: String,
    staged: bool,
    untracked: bool,
) -> Result<String, String> {
    let out = if untracked {
        run_git_diff(
            &project_path,
            &["diff", "--no-index", "--no-color", "--", NULL_DEVICE, &path],
        )
        .await?
    } else if staged {
        run_git(&project_path, &["diff", "--cached", "--no-color", "--", &path]).await?
    } else {
        run_git(&project_path, &["diff", "--no-color", "--", &path]).await?
    };
    Ok(head(&out, MAX_DIFF_LINES))
}

/// A generated file can be millions of lines; the modal renders every
/// one of them as a DOM row. Past this the diff is truncated with a note.
const MAX_DIFF_LINES: usize = 20_000;

/// Not a real path even on unix — git's `--no-index` special-cases this
/// exact string in `get_mode()`, on every platform including Windows.
const NULL_DEVICE: &str = "/dev/null";

/// The first `lines` lines, with a marker when anything was dropped.
fn head(text: &str, lines: usize) -> String {
    let mut kept: Vec<&str> = text.lines().take(lines).collect();
    if text.lines().nth(lines).is_some() {
        kept.push("… diff truncated — too large to display in full.");
    }
    kept.join("\n")
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
    // --all includes remote-tracking refs, so branches that only exist
    // on the remote (fetched, never checked out) are offered too.
    let out = run_git(
        &project_path,
        &["branch", "--all", "--format=%(HEAD)%09%(refname:short)%09%(refname)"],
    )
    .await?;
    Ok(vcs::parse_branches(&out))
}

/// What separates the current branch from the one it tracks — the
/// numbers on the Pull and Push buttons.
///
/// Null rather than an error for every "there is nothing to compare"
/// case (no upstream, detached HEAD, empty repo, not a repository):
/// git fails on all of them, and none is a problem the user has to be
/// told about. Reads local refs only — what the remote has moved on to
/// is known only as far as the last fetch.
#[tauri::command]
pub async fn git_upstream(project_path: String) -> Result<Option<Divergence>, String> {
    let out = run_git(
        &project_path,
        &["rev-list", "--left-right", "--count", "@{upstream}...HEAD"],
    )
    .await
    .unwrap_or_default();
    Ok(vcs::parse_ahead_behind(&out))
}

#[tauri::command]
pub async fn git_checkout(project_path: String, branch: String) -> Result<String, String> {
    // Branch names come from `git branch` output of the opened repo. A
    // hostile repo can hold refs created via plumbing that start with
    // `-`; git would parse those as option flags. Legitimate branches
    // can never start with `-` (check-ref-format forbids it).
    if branch.starts_with('-') {
        return Err(format!("Refusing to check out suspicious ref name: {branch}"));
    }
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

/// Update the remote-tracking branches without touching the working
/// tree — the safe "what's new upstream?" that pull isn't. `--prune`
/// drops refs for branches deleted on the remote, so the branch picker
/// doesn't accumulate ghosts.
#[tauri::command]
pub async fn git_fetch(project_path: String) -> Result<String, String> {
    // git writes fetch progress to stderr and leaves stdout empty, so a
    // successful no-op summarises as "Done." rather than staying blank.
    run_git(&project_path, &["fetch", "--prune"]).await.map(summary)
}

/// Every checkout of this repository, main first. Run from any of them —
/// git resolves the shared `.git` either way.
#[tauri::command]
pub async fn git_worktree_list(project_path: String) -> Result<Vec<Worktree>, String> {
    let out = run_git(&project_path, &["worktree", "list", "--porcelain"]).await?;
    Ok(vcs::parse_worktrees(&out))
}

/// Create a worktree at `worktree_path` for `branch`. `mode` picks the
/// shape: "existing" checks out a local branch, "new" creates the branch
/// from HEAD, "remote" creates a local tracking branch from `remote` —
/// `worktree add` does not DWIM remote branches the way `checkout` does.
#[tauri::command]
pub async fn git_worktree_add(
    project_path: String,
    worktree_path: String,
    branch: String,
    mode: String,
    remote: String,
) -> Result<String, String> {
    // Same reasoning as git_checkout: refs and paths that start with `-`
    // would be parsed as option flags. Legitimate branch and remote names
    // can never start with `-`, and the app derives absolute paths.
    if branch.starts_with('-') {
        return Err(format!("Refusing to use suspicious ref name: {branch}"));
    }
    if remote.starts_with('-') || remote.is_empty() {
        return Err(format!("Refusing to use suspicious remote name: {remote}"));
    }
    if worktree_path.starts_with('-') || !std::path::Path::new(&worktree_path).is_absolute() {
        return Err(format!("Worktree path must be absolute: {worktree_path}"));
    }
    let remote_branch = format!("{remote}/{branch}");
    let args: &[&str] = match mode.as_str() {
        "existing" => &["worktree", "add", "--", &worktree_path, &branch],
        "new" => &["worktree", "add", "-b", &branch, &worktree_path],
        "remote" => &["worktree", "add", "--track", "-b", &branch, &worktree_path, &remote_branch],
        other => return Err(format!("Unknown worktree mode: {other}")),
    };
    run_git(&project_path, args).await.map(summary)
}

/// Remove a linked worktree, deleting its folder. `mode` is "safe" or
/// "force"; forcing is what git demands when the worktree holds work.
///
/// Unlike `add`, this one deletes a directory tree, so the path is not
/// merely validated but *verified*: it must be one of the checkouts git
/// itself lists, and not the main one. Without that, any absolute path
/// handed to this command would be a recursive delete.
#[tauri::command]
pub async fn git_worktree_remove(
    project_path: String,
    worktree_path: String,
    mode: String,
) -> Result<String, String> {
    let args = worktree::remove_args(&worktree_path, &mode)?;
    let listed = run_git(&project_path, &["worktree", "list", "--porcelain"]).await?;
    let known = vcs::parse_worktrees(&listed)
        .into_iter()
        .find(|w| same_path(&w.path, &worktree_path))
        .ok_or_else(|| format!("Not a worktree of this repository: {worktree_path}"))?;
    if known.main {
        return Err("The main checkout cannot be removed.".to_owned());
    }
    if known.locked && mode != "force" {
        return Err("This worktree is locked. Unlock it in git first.".to_owned());
    }
    let borrowed: Vec<&str> = args.iter().map(String::as_str).collect();
    run_git(&project_path, &borrowed).await.map(summary)
}

/// Drop the bookkeeping for worktrees whose folders are already gone.
#[tauri::command]
pub async fn git_worktree_prune(project_path: String) -> Result<String, String> {
    run_git(&project_path, &["worktree", "prune"]).await.map(summary)
}

/// Branches already merged into `base` — the signal that a worktree's
/// work is done and its disk is free. `--merged` changes which refs are
/// listed, not how they are printed, so the existing parser reads it.
#[tauri::command]
pub async fn git_branches_merged(
    project_path: String,
    base: String,
) -> Result<Vec<Branch>, String> {
    if base.starts_with('-') {
        return Err(format!("Refusing to use suspicious ref name: {base}"));
    }
    let out = run_git(
        &project_path,
        &["branch", "--merged", &base, "--format=%(HEAD)%09%(refname:short)%09%(refname)"],
    )
    .await?;
    Ok(vcs::parse_branches(&out))
}

/// Git prints the path it recorded; the app may hold the one the OS
/// dialog gave back. They name the same folder with different slashes.
fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

fn summary(output: String) -> String {
    let trimmed = output.trim();
    if trimmed.is_empty() {
        "Done.".to_owned()
    } else {
        tail(trimmed, 2)
    }
}
