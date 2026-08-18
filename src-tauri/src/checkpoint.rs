//! Checkpoint handlers — the git side of `/rewind`.
//!
//! A checkpoint is a commit built from a throwaway index, so taking one
//! leaves the user's index, HEAD, and branch exactly where they were.
//! Rewinding writes only the paths `git diff` itself named. Argv and
//! output parsing are pure and live in `agent_core::checkpoint`.

use agent_core::checkpoint::{self, CheckpointChange, DiffStat};
use serde::Serialize;

use crate::fs_confine::confine_to_project;
use crate::runner;

/// Run git in the project folder, optionally against a throwaway index.
///
/// `GIT_INDEX_FILE` is the whole trick: `add -A` stages the work tree
/// into that file instead of `.git/index`, so the user's own staged /
/// unstaged split is never disturbed.
async fn run_git(project_path: &str, args: &[String], index: Option<&str>) -> Result<String, String> {
    let mut full_args = vec!["-C".to_owned(), project_path.to_owned()];
    full_args.extend(args.iter().cloned());

    let mut command = runner::os_command("git", &full_args);
    command.env("GIT_TERMINAL_PROMPT", "0");
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }

    let output = command
        .output()
        .await
        .map_err(|e| format!("Could not run git: {e}"))?;

    let stdout = String::from_utf8_lossy(&output.stdout).into_owned();
    if output.status.success() {
        Ok(stdout)
    } else {
        Err(agent_core::vcs::explain_failure(
            String::from_utf8_lossy(&output.stderr).trim(),
        ))
    }
}

/// A private index file per checkpoint, removed as soon as the tree is
/// written. Concurrent tabs each get their own — two projects taking a
/// checkpoint at once must not share one.
struct TempIndex(std::path::PathBuf);

impl TempIndex {
    fn new() -> Self {
        let name = format!(
            "mota-index-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        );
        Self(std::env::temp_dir().join(name))
    }

    fn path(&self) -> String {
        self.0.to_string_lossy().into_owned()
    }
}

impl Drop for TempIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

/// Is this folder somewhere a checkpoint can be taken at all? Without a
/// work tree there is no cheap content-addressed store to lean on, and
/// the feature turns itself off rather than inventing a worse one.
#[tauri::command]
pub async fn checkpoint_available(project_path: String) -> Result<bool, String> {
    let out = run_git(
        &project_path,
        &["rev-parse".to_owned(), "--is-inside-work-tree".to_owned()],
        None,
    )
    .await
    .unwrap_or_default();
    Ok(out.trim() == "true")
}

/// Snapshot the work tree and return the commit to rewind to.
///
/// `session_id` only names the ref the chain hangs from; every
/// checkpoint parents the previous one so a single ref keeps them all
/// reachable and safe from `git gc`.
#[tauri::command]
pub async fn checkpoint_create(project_path: String, session_id: String) -> Result<String, String> {
    let reference = checkpoint::ref_name(&session_id);

    // The chain's tip if this session already has one, else HEAD, else
    // nothing at all — a repository with no commits is still worth
    // checkpointing, it just starts from an empty index.
    let parent = rev_parse(&project_path, &reference)
        .await
        .or(rev_parse(&project_path, "HEAD").await);

    let tree = write_current_tree(&project_path, parent.as_deref()).await?;

    let commit = run_git(
        &project_path,
        &checkpoint::commit_tree_args(&tree, parent.as_deref()),
        None,
    )
    .await?
    .trim()
    .to_owned();

    run_git(
        &project_path,
        &[
            "update-ref".to_owned(),
            reference,
            commit.clone(),
        ],
        None,
    )
    .await?;

    Ok(commit)
}

/// Stage the whole work tree into a throwaway index and write it out as
/// a tree object. Nothing is committed and the real index is untouched;
/// the result is just a name for "how things are right now" that git can
/// compare against.
async fn write_current_tree(
    project_path: &str,
    parent: Option<&str>,
) -> Result<String, String> {
    let index = TempIndex::new();
    let mut tree = String::new();
    for step in checkpoint::tree_steps(parent) {
        tree = run_git(project_path, &step, Some(&index.path())).await?;
    }
    Ok(tree.trim().to_owned())
}

/// Resolve a revision, or `None` when it does not exist — an unborn
/// branch and a session with no checkpoints yet are both normal.
async fn rev_parse(project_path: &str, revision: &str) -> Option<String> {
    let out = run_git(
        project_path,
        &[
            "rev-parse".to_owned(),
            "--verify".to_owned(),
            "--quiet".to_owned(),
            format!("{revision}^{{commit}}"),
        ],
        None,
    )
    .await
    .ok()?;
    let trimmed = out.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_owned())
}

/// What rewinding to this checkpoint would do, for the confirm dialog.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointPreview {
    pub changes: Vec<CheckpointChange>,
    pub stat: DiffStat,
}

#[tauri::command]
pub async fn checkpoint_preview(
    project_path: String,
    commit: String,
) -> Result<CheckpointPreview, String> {
    let now = write_current_tree(&project_path, Some("HEAD")).await?;
    let changes = changes_since(&project_path, &commit, &now).await?;
    let shortstat = run_git(
        &project_path,
        &checkpoint::shortstat_args(&commit, &now),
        None,
    )
    .await?;
    Ok(CheckpointPreview {
        changes,
        stat: checkpoint::parse_shortstat(&shortstat),
    })
}

async fn changes_since(
    project_path: &str,
    commit: &str,
    now: &str,
) -> Result<Vec<CheckpointChange>, String> {
    let out = run_git(project_path, &checkpoint::diff_args(commit, now), None).await?;
    Ok(checkpoint::parse_name_status(&out))
}

/// Put the work tree back the way it was at `commit`.
///
/// Only the paths git named are touched: files it reports as modified or
/// deleted are written back from the checkpoint's tree, and the only
/// files removed are the ones it reports as added since. The index,
/// HEAD, and the current branch are never written.
#[tauri::command]
pub async fn checkpoint_restore(
    project_path: String,
    commit: String,
) -> Result<Vec<String>, String> {
    let now = write_current_tree(&project_path, Some("HEAD")).await?;
    let changes = changes_since(&project_path, &commit, &now).await?;
    let plan = checkpoint::restore_plan(&changes);

    if !plan.restore.is_empty() {
        // A fresh temp index holding the checkpoint's tree, so
        // checkout-index has something to write from without the real
        // index ever seeing it.
        let index = TempIndex::new();
        run_git(
            &project_path,
            &["read-tree".to_owned(), commit.clone()],
            Some(&index.path()),
        )
        .await?;

        // A turn that deleted a whole folder leaves nowhere to write
        // its files back to. Some git versions create the leading
        // directories themselves and some do not, so do it here rather
        // than depend on which one is installed.
        for path in &plan.restore {
            let absolute = std::path::Path::new(&project_path).join(path);
            if let Some(parent) = absolute.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
        }

        // Named paths only, never `-a`: rewriting every tracked file
        // would churn the mtime of the whole repository and invalidate
        // every build cache in it. Writing goes through git's own
        // checkout filters, so a restored file gets the same line
        // endings a fresh `git checkout` would give it.
        let mut args = vec![
            "checkout-index".to_owned(),
            "-f".to_owned(),
            "--".to_owned(),
        ];
        args.extend(plan.restore.iter().cloned());
        run_git(&project_path, &args, Some(&index.path())).await?;
    }

    for path in &plan.delete {
        // git named these relative to the project; confine anyway. The
        // one code path in this feature that removes a file is the one
        // place a surprise is least affordable — and confinement also
        // refuses a path that resolves outside via a symlinked folder.
        let Ok(absolute) = confine_to_project(&project_path, &full_path(&project_path, path), true)
        else {
            // Already gone, or no longer resolves inside the project.
            // Either way there is nothing here worth failing a restore
            // that has already written every other file.
            continue;
        };
        std::fs::remove_file(&absolute).map_err(|e| format!("Could not remove {path}: {e}"))?;
    }

    Ok(changes.into_iter().map(|change| change.path).collect())
}

fn full_path(project_path: &str, path: &str) -> String {
    std::path::Path::new(project_path)
        .join(path)
        .to_string_lossy()
        .into_owned()
}

/// One file's diff between a checkpoint and the work tree, for the diff
/// viewer. Mirrors `git::git_diff`'s contract: text, possibly empty.
#[tauri::command]
pub async fn checkpoint_file_diff(
    project_path: String,
    commit: String,
    path: String,
) -> Result<String, String> {
    // A file deleted since the checkpoint has no side to compare
    // against, which git reports by printing the whole file as
    // removals — no special case needed here.
    let now = write_current_tree(&project_path, Some("HEAD")).await?;
    run_git(
        &project_path,
        &checkpoint::file_diff_args(&commit, &now, &path),
        None,
    )
    .await
}

/// Drop a session's checkpoint chain. The commits become unreachable and
/// `git gc` reclaims them on its own schedule.
#[tauri::command]
pub async fn checkpoint_forget(project_path: String, session_id: String) -> Result<(), String> {
    let reference = checkpoint::ref_name(&session_id);
    let _ = run_git(
        &project_path,
        &["update-ref".to_owned(), "-d".to_owned(), reference],
        None,
    )
    .await;
    Ok(())
}

/// Only `Fate::Delete` ever removes a file, and it is worth one test in
/// the shell too: the driver above must not grow a second delete path.
#[cfg(test)]
mod tests {
    use super::*;
    use agent_core::checkpoint::Fate;

    #[test]
    fn the_driver_deletes_exactly_what_the_plan_says() {
        let changes = vec![
            CheckpointChange {
                path: "kept.rs".to_owned(),
                fate: Fate::Restore,
                label: "modified".to_owned(),
            },
            CheckpointChange {
                path: "new.rs".to_owned(),
                fate: Fate::Delete,
                label: "added".to_owned(),
            },
        ];
        let plan = checkpoint::restore_plan(&changes);
        assert_eq!(plan.delete, vec!["new.rs"]);
        assert_eq!(plan.restore, vec!["kept.rs"]);
    }

    #[test]
    fn a_temp_index_is_removed_when_it_falls_out_of_scope() {
        let path = {
            let index = TempIndex::new();
            std::fs::write(&index.0, b"x").unwrap();
            index.0.clone()
        };
        assert!(!path.exists(), "the temp index outlived its checkpoint");
    }

    // --- Against a real repository. Everything above tests decisions;
    // these test that git actually behaves the way those decisions
    // assume, which is the half that would otherwise only be found by
    // losing someone's work.

    async fn git(dir: &std::path::Path, args: &[&str]) -> String {
        run_git(
            &dir.to_string_lossy(),
            &args.iter().map(|a| (*a).to_owned()).collect::<Vec<_>>(),
            None,
        )
        .await
        .unwrap_or_else(|e| panic!("git {args:?} failed: {e}"))
    }

    /// A repository with one commit, a staged change and an unstaged one
    /// — the everyday state a checkpoint must not disturb.
    async fn repo() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_owned();
        git(&path, &["init", "--quiet", "."]).await;
        git(&path, &["config", "user.email", "test@example.com"]).await;
        git(&path, &["config", "user.name", "Test"]).await;
        // A restore is a checkout, so it runs the repository's filters —
        // on a machine with `core.autocrlf=true` a restored file comes
        // back with CRLF, exactly as `git checkout` would leave it. Real
        // behaviour, but it must not decide whether this test passes.
        git(&path, &["config", "core.autocrlf", "false"]).await;
        std::fs::write(path.join("kept.txt"), "one\n").unwrap();
        std::fs::write(path.join("dirty.txt"), "two\n").unwrap();
        std::fs::write(path.join(".gitignore"), "ignored/\n").unwrap();
        std::fs::create_dir(path.join("ignored")).unwrap();
        std::fs::write(path.join("ignored").join("junk.txt"), "junk\n").unwrap();
        git(&path, &["add", "-A"]).await;
        git(&path, &["commit", "--quiet", "-m", "init"]).await;
        std::fs::write(path.join("kept.txt"), "one-staged\n").unwrap();
        git(&path, &["add", "kept.txt"]).await;
        std::fs::write(path.join("dirty.txt"), "two-dirty\n").unwrap();
        dir
    }

    #[tokio::test]
    async fn taking_a_checkpoint_leaves_the_index_and_head_alone() {
        let dir = repo().await;
        let path = dir.path().to_string_lossy().into_owned();
        let before = git(dir.path(), &["status", "--porcelain"]).await;
        let head_before = git(dir.path(), &["rev-parse", "HEAD"]).await;

        checkpoint_create(path.clone(), "tab-1".to_owned())
            .await
            .unwrap();

        assert_eq!(
            git(dir.path(), &["status", "--porcelain"]).await,
            before,
            "the user's staged/unstaged split moved"
        );
        assert_eq!(git(dir.path(), &["rev-parse", "HEAD"]).await, head_before);
    }

    #[tokio::test]
    async fn an_ignored_file_is_not_in_the_snapshot() {
        let dir = repo().await;
        let path = dir.path().to_string_lossy().into_owned();
        let commit = checkpoint_create(path.clone(), "tab-1".to_owned())
            .await
            .unwrap();
        let tree = git(dir.path(), &["ls-tree", "-r", "--name-only", commit.trim()]).await;
        assert!(
            !tree.contains("ignored/"),
            "a checkpoint that snapshots node_modules is not a lightweight one: {tree}"
        );
    }

    #[tokio::test]
    async fn rewinding_restores_edits_deletions_and_removes_new_files() {
        let dir = repo().await;
        let path = dir.path().to_string_lossy().into_owned();
        let commit = checkpoint_create(path.clone(), "tab-1".to_owned())
            .await
            .unwrap();

        // A turn that edits, creates and deletes — including through a
        // shell, which reports no diff and is the whole reason the
        // snapshot is git's and not the agent's.
        std::fs::write(dir.path().join("kept.txt"), "RUINED\n").unwrap();
        std::fs::write(dir.path().join("brand-new.txt"), "new\n").unwrap();
        std::fs::remove_file(dir.path().join("dirty.txt")).unwrap();

        let preview = checkpoint_preview(path.clone(), commit.clone()).await.unwrap();
        let named: Vec<&str> = preview.changes.iter().map(|c| c.path.as_str()).collect();
        assert!(named.contains(&"brand-new.txt"), "untracked add went unseen: {named:?}");
        assert!(named.contains(&"kept.txt"));
        assert!(named.contains(&"dirty.txt"));
        assert_eq!(preview.stat.files, 3);

        checkpoint_restore(path.clone(), commit.clone()).await.unwrap();

        assert_eq!(
            std::fs::read_to_string(dir.path().join("kept.txt")).unwrap(),
            "one-staged\n"
        );
        assert_eq!(
            std::fs::read_to_string(dir.path().join("dirty.txt")).unwrap(),
            "two-dirty\n"
        );
        assert!(
            !dir.path().join("brand-new.txt").exists(),
            "a file created since the checkpoint survived the rewind"
        );

        // And the whole point: nothing is left to undo.
        let after = checkpoint_preview(path, commit).await.unwrap();
        assert_eq!(after.stat.files, 0, "the rewind did not land: {after:?}");
    }

    #[tokio::test]
    async fn rewinding_restores_a_file_whose_folder_was_deleted() {
        let dir = repo().await;
        let path = dir.path().to_string_lossy().into_owned();
        std::fs::create_dir_all(dir.path().join("deep/nest")).unwrap();
        std::fs::write(dir.path().join("deep/nest/f.txt"), "x\n").unwrap();
        let commit = checkpoint_create(path.clone(), "tab-1".to_owned())
            .await
            .unwrap();

        std::fs::remove_file(dir.path().join("deep/nest/f.txt")).unwrap();
        std::fs::remove_dir(dir.path().join("deep/nest")).unwrap();
        std::fs::remove_dir(dir.path().join("deep")).unwrap();

        checkpoint_restore(path, commit).await.unwrap();
        assert_eq!(
            std::fs::read_to_string(dir.path().join("deep/nest/f.txt")).unwrap(),
            "x\n"
        );
    }

    #[tokio::test]
    async fn checkpoints_chain_so_gc_cannot_reach_the_older_ones() {
        let dir = repo().await;
        let path = dir.path().to_string_lossy().into_owned();
        let first = checkpoint_create(path.clone(), "tab-1".to_owned())
            .await
            .unwrap();
        std::fs::write(dir.path().join("kept.txt"), "moved on\n").unwrap();
        let second = checkpoint_create(path.clone(), "tab-1".to_owned())
            .await
            .unwrap();
        assert_ne!(first, second);

        // Aggressive gc prunes anything no ref can reach. The chain is
        // what keeps the first checkpoint alive after the second.
        git(
            dir.path(),
            &["gc", "--prune=now", "--aggressive", "--quiet"],
        )
        .await;
        checkpoint_preview(path, first)
            .await
            .expect("the older checkpoint was collected");
    }

    #[tokio::test]
    async fn a_folder_that_is_not_a_repository_says_so_instead_of_pretending() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().to_string_lossy().into_owned();
        assert!(!checkpoint_available(path.clone()).await.unwrap());
        assert!(checkpoint_create(path, "tab-1".to_owned()).await.is_err());
    }
}
