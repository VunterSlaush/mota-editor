//! Worktree provisioning — the disk half of `agent_core::worktree`.
//!
//! A fresh worktree has none of the folders git does not track, so it
//! cannot build until `node_modules` and a build target are back. This
//! module puts them there: a link when the folder is meant to be shared,
//! a copy otherwise — made with the filesystem's own clone where it has
//! one, so the copy costs close to nothing. Every decision about *what*
//! to do is `agent_core::worktree`'s; this file only probes and acts.

use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use agent_core::worktree::{
    plan_step, roll_up, should_unlink, validate_entry_path, DiskUsage, PathKind, PlanStep,
    ProvisionEntry, ProvisionStrategy, RawEntry,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter};

use crate::commands::run_blocking;
use crate::runner;

/// Progress rides its own channel: `AgentEvent` is the agent's
/// vocabulary and has no business learning about disks.
pub const PROVISION_CHANNEL: &str = "worktree-provision";

/// How long a size walk may run before it reports a lower bound.
const DEFAULT_BUDGET_MS: u64 = 1_500;
/// A second stop for a walk that is fast but endless.
const MAX_WALK_ENTRIES: usize = 500_000;
/// How often the deadline is consulted — a syscall per file would cost
/// more than the walk it guards.
const DEADLINE_EVERY: usize = 512;

/// Worktrees being provisioned right now. A second request for one that
/// is already running is answered, not raced: two copies into the same
/// directory would interleave.
#[derive(Default)]
pub struct Provisioning(Mutex<HashSet<String>>);

impl Provisioning {
    fn claim(&self, path: &str) -> bool {
        self.0.lock().map(|mut set| set.insert(path.to_owned())).unwrap_or(false)
    }

    fn release(&self, path: &str) {
        if let Ok(mut set) = self.0.lock() {
            set.remove(path);
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionArgs {
    pub main_path: String,
    pub worktree_path: String,
    pub entries: Vec<ProvisionEntry>,
}

/// What became of one folder. Never an error: a folder that could not be
/// prepared leaves the worktree usable, just emptier.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryOutcome {
    pub path: String,
    pub strategy: ProvisionStrategy,
    /// "linked" | "copied" | "skipped" | "already" | "failed"
    pub outcome: String,
    pub message: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionReport {
    pub worktree_path: String,
    pub entries: Vec<EntryOutcome>,
    /// True when nothing failed. Skipping is not failing.
    pub ok: bool,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct ProvisionProgress<'a> {
    worktree_path: &'a str,
    path: &'a str,
    index: usize,
    total: usize,
    /// "started" | "finished"
    phase: &'a str,
    outcome: Option<&'a str>,
}

/// Stock a new worktree with the folders git does not carry.
///
/// Returns `Err` only when the request itself is malformed. A folder
/// that cannot be prepared comes back as a failed entry inside an `Ok`
/// report, because the worktree exists either way and refusing the whole
/// call would say otherwise.
#[tauri::command]
pub async fn worktree_provision(
    app: AppHandle,
    state: tauri::State<'_, Provisioning>,
    args: ProvisionArgs,
) -> Result<ProvisionReport, String> {
    let ProvisionArgs { main_path, worktree_path, entries } = args;
    if !Path::new(&worktree_path).is_absolute() || !Path::new(&main_path).is_absolute() {
        return Err("Worktree and main checkout paths must be absolute.".to_owned());
    }
    if same_path(&main_path, &worktree_path) {
        return Err("A checkout cannot be provisioned from itself.".to_owned());
    }
    if !state.claim(&worktree_path) {
        return Err("This worktree is already being prepared.".to_owned());
    }

    let total = entries.len();
    let mut outcomes = Vec::with_capacity(total);
    // Sequentially: two multi-gigabyte copies on one disk finish later
    // than the same two in a row, and the progress reads as nonsense.
    for (index, entry) in entries.into_iter().enumerate() {
        emit_progress(&app, &worktree_path, &entry.path, index, total, "started", None);
        let outcome = provision_one(&main_path, &worktree_path, &entry).await;
        emit_progress(
            &app,
            &worktree_path,
            &entry.path,
            index,
            total,
            "finished",
            Some(&outcome.outcome),
        );
        outcomes.push(outcome);
    }
    state.release(&worktree_path);

    let ok = outcomes.iter().all(|o| o.outcome != "failed");
    Ok(ProvisionReport { worktree_path, entries: outcomes, ok })
}

async fn provision_one(
    main_path: &str,
    worktree_path: &str,
    entry: &ProvisionEntry,
) -> EntryOutcome {
    let failed = |message: String| EntryOutcome {
        path: entry.path.clone(),
        strategy: entry.strategy,
        outcome: "failed".to_owned(),
        message,
    };

    let relative = match validate_entry_path(&entry.path) {
        Ok(relative) => relative,
        Err(why) => return failed(why),
    };
    let source = join(main_path, &relative);
    let target = join(worktree_path, &relative);

    let probe = {
        let (source, target) = (source.clone(), target.clone());
        run_blocking(move || Ok((probe_path(&source), probe_path(&target)))).await
    };
    let (source_kind, target_kind) = match probe {
        Ok(kinds) => kinds,
        Err(e) => return failed(e),
    };

    let source_display = source.to_string_lossy().to_string();
    match plan_step(&source_kind, &target_kind, entry.strategy, &source_display) {
        PlanStep::Skip(why) => EntryOutcome {
            path: entry.path.clone(),
            strategy: entry.strategy,
            outcome: "skipped".to_owned(),
            message: why,
        },
        PlanStep::AlreadyProvisioned => EntryOutcome {
            path: entry.path.clone(),
            strategy: entry.strategy,
            outcome: "already".to_owned(),
            message: "Already prepared.".to_owned(),
        },
        PlanStep::Conflict(why) => failed(why),
        step => {
            let clear = matches!(step, PlanStep::ClearThenLink | PlanStep::ClearThenCopy);
            let link = matches!(step, PlanStep::Link | PlanStep::ClearThenLink);
            if let Err(e) = prepare_target(&target, clear).await {
                return failed(e);
            }
            let result = if link {
                let (source, target) = (source.clone(), target.clone());
                run_blocking(move || symlink_dir(&source, &target)).await
            } else {
                copy_tree(&source, &target).await
            };
            match result {
                Ok(()) => EntryOutcome {
                    path: entry.path.clone(),
                    strategy: entry.strategy,
                    outcome: if link { "linked" } else { "copied" }.to_owned(),
                    message: String::new(),
                },
                Err(e) => failed(e),
            }
        }
    }
}

/// Make room: the parent must exist for a nested path like
/// `src-tauri/target`, and an empty directory in the way is removed with
/// the non-recursive call, which fails rather than deletes if it turns
/// out to hold anything after all.
async fn prepare_target(target: &Path, clear: bool) -> Result<(), String> {
    let target = target.to_path_buf();
    run_blocking(move || {
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| format!("Could not create {}: {e}", parent.display()))?;
        }
        if clear {
            std::fs::remove_dir(&target)
                .map_err(|e| format!("Could not clear {}: {e}", target.display()))?;
        }
        Ok(())
    })
    .await
}

/// What the disk holds, without following links: a link's own identity
/// is the whole point of the decision it feeds.
fn probe_path(path: &Path) -> PathKind {
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return PathKind::Missing;
    };
    if meta.file_type().is_symlink() {
        return match std::fs::read_link(path) {
            Ok(dest) => PathKind::SymlinkTo(dest.to_string_lossy().to_string()),
            Err(_) => PathKind::SymlinkTo(String::new()),
        };
    }
    if meta.is_dir() {
        let empty =
            std::fs::read_dir(path).map(|mut d| d.next().is_none()).unwrap_or(false);
        return PathKind::Dir { empty };
    }
    PathKind::File
}

#[cfg(unix)]
fn symlink_dir(source: &Path, target: &Path) -> Result<(), String> {
    std::os::unix::fs::symlink(source, target)
        .map_err(|e| format!("Could not link {}: {e}", target.display()))
}

#[cfg(windows)]
fn symlink_dir(source: &Path, target: &Path) -> Result<(), String> {
    std::os::windows::fs::symlink_dir(source, target).map_err(|e| {
        // 1314 is ERROR_PRIVILEGE_NOT_HELD. Quietly copying gigabytes
        // instead would be a worse surprise than saying so.
        if e.raw_os_error() == Some(1314) {
            "Windows needs Developer Mode to link folders — choose Copy instead.".to_owned()
        } else {
            format!("Could not link {}: {e}", target.display())
        }
    })
}

/// Copy a tree, letting the filesystem share the blocks where it can.
///
/// Shelling out to the platform's own copy tool is what buys that: APFS
/// clones a whole directory in one syscall, and no Rust crate reaches
/// it. `os_command` spawns the resolved binary with an argv vector and
/// never a shell, and both paths are app-derived absolutes passed after
/// `--`, so there is nothing here for a metacharacter to do.
async fn copy_tree(source: &Path, target: &Path) -> Result<(), String> {
    let (src, dst) = (path_arg(source), path_arg(target));

    #[cfg(target_os = "macos")]
    {
        // `-c` asks for a clone and errors out where it cannot, rather
        // than degrading, so the plain copy is a real fallback.
        let cloned =
            run_copy("cp", &["-c".into(), "-R".into(), "-p".into(), "--".into(), src.clone(), dst.clone()])
                .await;
        if cloned.is_ok() {
            return cloned;
        }
        let _ = std::fs::remove_dir_all(target);
        run_copy("cp", &["-R".into(), "-p".into(), "--".into(), src, dst]).await
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        // `--reflink=auto` shares blocks on btrfs/xfs and copies
        // everywhere else; `-T` stops a copy *into* an existing target.
        run_copy("cp", &["-a".into(), "--reflink=auto".into(), "-T".into(), "--".into(), src, dst])
            .await
    }

    #[cfg(windows)]
    {
        run_copy(
            "robocopy",
            &[
                src,
                dst,
                "/E".into(),
                "/COPY:DAT".into(),
                "/DCOPY:DAT".into(),
                "/NFL".into(),
                "/NDL".into(),
                "/NJH".into(),
                "/NJS".into(),
                "/NP".into(),
                "/R:1".into(),
                "/W:1".into(),
            ],
        )
        .await
    }
}

async fn run_copy(program: &str, args: &[String]) -> Result<(), String> {
    let output = runner::os_command(program, args)
        .output()
        .await
        .map_err(|e| format!("Could not run {program}: {e}"))?;
    if copy_succeeded(program, output.status.code()) {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr);
    let detail = stderr.trim().lines().last().unwrap_or("no error message").to_owned();
    Err(format!("{program} failed: {detail}"))
}

/// Robocopy reports what it did in its exit code: 0-7 are degrees of
/// success (files copied, extras found), 8 and up are real failures.
/// Treating a non-zero exit as failure the way every other tool does
/// would report every successful copy as broken.
fn copy_succeeded(program: &str, code: Option<i32>) -> bool {
    match code {
        Some(code) if program == "robocopy" => code < 8,
        Some(code) => code == 0,
        None => false,
    }
}

/// Remove the links this worktree was given, and nothing else.
///
/// Deleting a worktree deletes what is inside it, and a link to the main
/// checkout's `node_modules` looks like a folder to anything that does
/// not check. Removal itself is safe — every tool that recurses uses
/// `lstat` and unlinks a symlink rather than descending — but the tail
/// of tools that get this wrong on Windows is long enough that the links
/// come out first, on every platform.
#[tauri::command]
pub async fn worktree_unprovision(
    worktree_path: String,
    paths: Vec<String>,
) -> Result<Vec<String>, String> {
    if !Path::new(&worktree_path).is_absolute() {
        return Err("Worktree path must be absolute.".to_owned());
    }
    run_blocking(move || {
        let mut removed = Vec::new();
        for path in paths {
            let Ok(relative) = validate_entry_path(&path) else { continue };
            let target = join(&worktree_path, &relative);
            if !should_unlink(&probe_path(&target)) {
                continue; // a real folder is the worktree's own; leave it
            }
            // A directory symlink comes off with remove_dir on Windows
            // and remove_file elsewhere; try both rather than branch.
            let gone = std::fs::remove_file(&target).is_ok()
                || std::fs::remove_dir(&target).is_ok();
            if gone {
                removed.push(relative);
            }
        }
        Ok(removed)
    })
    .await
}

/// Whether this disk can copy without duplicating the bytes. Probed by
/// trying it, not guessed from the filesystem's name: network mounts,
/// disk images and container filesystems all lie about what they are.
#[tauri::command]
pub async fn worktree_supports_cow(path: String) -> Result<bool, String> {
    let dir = std::env::temp_dir().join(format!("mota-cow-{}", sanitize_probe_key(&path)));
    let source = dir.join("source");
    let target = dir.join("target");

    let setup = {
        let (dir, source, target) = (dir.clone(), source.clone(), target.clone());
        run_blocking(move || {
            let _ = std::fs::remove_file(&target);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            std::fs::write(&source, b"mota").map_err(|e| e.to_string())
        })
        .await
    };
    if setup.is_err() {
        return Ok(false);
    }

    let supported = clone_file(&source, &target).await;
    let _ = run_blocking(move || {
        let _ = std::fs::remove_dir_all(&dir);
        Ok(())
    })
    .await;
    Ok(supported)
}

async fn clone_file(source: &Path, target: &Path) -> bool {
    let (src, dst) = (path_arg(source), path_arg(target));
    #[cfg(target_os = "macos")]
    {
        run_copy("cp", &["-c".into(), "--".into(), src, dst]).await.is_ok()
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        run_copy("cp", &["--reflink=always".into(), "--".into(), src, dst]).await.is_ok()
    }
    #[cfg(windows)]
    {
        let _ = (src, dst);
        false // no shipped Windows tool exposes ReFS block cloning
    }
}

/// A temp-file name that cannot escape the temp directory.
fn sanitize_probe_key(path: &str) -> String {
    path.chars().filter(|c| c.is_ascii_alphanumeric()).take(24).collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsageArgs {
    pub worktree_path: String,
    /// Folders provisioned as shared or copied — counted apart, because
    /// what they cost belongs to the main checkout, not to this worktree.
    #[serde(default)]
    pub shared_paths: Vec<String>,
    #[serde(default)]
    pub budget_ms: Option<u64>,
}

/// What a worktree costs on disk, one line per top-level folder.
#[tauri::command]
pub async fn worktree_disk_usage(args: DiskUsageArgs) -> Result<DiskUsage, String> {
    let DiskUsageArgs { worktree_path, shared_paths, budget_ms } = args;
    if !Path::new(&worktree_path).is_absolute() {
        return Err("Worktree path must be absolute.".to_owned());
    }
    let budget = budget_ms.unwrap_or(DEFAULT_BUDGET_MS);
    run_blocking(move || Ok(measure(&worktree_path, &shared_paths, budget))).await
}

fn measure(worktree_path: &str, shared_paths: &[String], budget_ms: u64) -> DiskUsage {
    let shared: HashSet<String> = shared_paths
        .iter()
        .filter_map(|p| validate_entry_path(p).ok())
        .map(|p| p.split('/').next().unwrap_or(&p).to_owned())
        .collect();

    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(budget_ms);
    let mut entries = Vec::new();
    let mut truncated = false;
    let mut budget = MAX_WALK_ENTRIES;

    let Ok(top) = std::fs::read_dir(worktree_path) else {
        return roll_up(&[], false);
    };
    for child in top.flatten() {
        let name = child.file_name().to_string_lossy().to_string();
        let is_shared = shared.contains(&name);
        let path = child.path();
        // A link costs its own bytes, not its destination's; walking it
        // would bill this worktree for the main checkout's folder.
        if std::fs::symlink_metadata(&path).map(|m| m.file_type().is_symlink()).unwrap_or(false) {
            entries.push(RawEntry { path: name, allocated: 0, apparent: 0, shared: true });
            continue;
        }
        let (allocated, apparent, stopped) = walk(&path, deadline, &mut budget);
        truncated |= stopped;
        entries.push(RawEntry { path: name, allocated, apparent, shared: is_shared });
    }
    roll_up(&entries, truncated)
}

/// Sum one folder iteratively — a `node_modules` is deep enough that
/// recursion is a real stack risk. Unreadable subtrees count as zero
/// rather than failing the whole measurement.
fn walk(
    root: &Path,
    deadline: std::time::Instant,
    budget: &mut usize,
) -> (u64, u64, bool) {
    let mut allocated = 0u64;
    let mut apparent = 0u64;
    let mut seen = 0usize;
    let mut stack = vec![root.to_path_buf()];
    #[cfg(unix)]
    let mut hardlinks: HashSet<(u64, u64)> = HashSet::new();

    while let Some(dir) = stack.pop() {
        let Ok(children) = std::fs::read_dir(&dir) else { continue };
        for child in children.flatten() {
            seen += 1;
            *budget = budget.saturating_sub(1);
            if *budget == 0 {
                return (allocated, apparent, true);
            }
            if seen.is_multiple_of(DEADLINE_EVERY) && std::time::Instant::now() > deadline {
                return (allocated, apparent, true);
            }
            let Ok(meta) = child.metadata() else { continue };
            if meta.is_dir() {
                stack.push(child.path());
                continue;
            }
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                // npm and cargo stores are full of hardlinks; the same
                // bytes must not be billed once per name.
                if meta.nlink() > 1 && !hardlinks.insert((meta.dev(), meta.ino())) {
                    continue;
                }
                allocated += meta.blocks() * 512;
            }
            #[cfg(not(unix))]
            {
                // No portable way to ask for the allocated size, so round
                // to the usual cluster and say so here rather than pretend.
                allocated += meta.len().div_ceil(4096) * 4096;
            }
            apparent += meta.len();
        }
    }
    (allocated, apparent, false)
}

fn emit_progress(
    app: &AppHandle,
    worktree_path: &str,
    path: &str,
    index: usize,
    total: usize,
    phase: &str,
    outcome: Option<&str>,
) {
    let _ = app.emit(
        PROVISION_CHANNEL,
        ProvisionProgress { worktree_path, path, index, total, phase, outcome },
    );
}

fn join(base: &str, relative: &str) -> PathBuf {
    let mut path = PathBuf::from(base);
    for segment in relative.split('/') {
        path.push(segment);
    }
    path
}

fn path_arg(path: &Path) -> String {
    path.to_string_lossy().to_string()
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn robocopy_exit_codes_below_eight_are_successes() {
        for code in 0..8 {
            assert!(copy_succeeded("robocopy", Some(code)), "{code} should succeed");
        }
        assert!(!copy_succeeded("robocopy", Some(8)));
        assert!(!copy_succeeded("robocopy", Some(16)));
    }

    #[test]
    fn every_other_tool_reports_success_only_as_zero() {
        assert!(copy_succeeded("cp", Some(0)));
        assert!(!copy_succeeded("cp", Some(1)));
    }

    #[test]
    fn a_killed_copy_is_never_a_success() {
        assert!(!copy_succeeded("cp", None));
        assert!(!copy_succeeded("robocopy", None));
    }

    #[test]
    fn joining_keeps_nested_entries_under_the_checkout() {
        let joined = join("/repos/app", "src-tauri/target");
        assert!(joined.ends_with("target"));
        assert!(joined.starts_with("/repos/app"));
    }

    #[test]
    fn the_probe_key_can_never_escape_the_temp_directory() {
        let key = sanitize_probe_key("../../etc/passwd");
        assert!(!key.contains('.') && !key.contains('/'));
    }

    #[test]
    fn a_missing_path_probes_as_missing() {
        assert_eq!(probe_path(Path::new("/nonexistent/mota/probe")), PathKind::Missing);
    }
}
