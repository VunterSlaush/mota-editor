//! Worktree provisioning — the decisions, not the doing. A new worktree
//! arrives without the heavy folders git does not track (`node_modules`,
//! a build target), so the shell stocks them by linking or copying. What
//! to do for a given pair of paths is decided here, where it is pure and
//! testable; the shell only probes the disk and carries the step out.

use serde::{Deserialize, Serialize};

/// How a worktree gets one heavy folder.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProvisionStrategy {
    /// One copy for every worktree, reached through a link.
    Share,
    /// A private copy, cloned by the filesystem where it can.
    Clone,
    /// Left out; the user installs or builds it.
    Skip,
}

/// One heavy folder and how a worktree should get it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvisionEntry {
    /// Repository-relative, e.g. `node_modules`.
    pub path: String,
    pub strategy: ProvisionStrategy,
}

/// What the disk holds at a path, as far as this decision cares. A
/// symlink is never followed: whether it points at the source we would
/// have linked ourselves is the difference between "already done" and
/// "someone else's link, leave it alone".
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PathKind {
    Missing,
    Dir { empty: bool },
    File,
    SymlinkTo(String),
}

/// The one action to take for an entry.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlanStep {
    /// Create the link.
    Link,
    /// Copy the tree.
    Copy,
    /// Remove the empty directory in the way, then link or copy.
    ClearThenLink,
    ClearThenCopy,
    /// Nothing to do; the reason is for the report, not the log.
    AlreadyProvisioned,
    Skip(String),
    /// Refuse and say why. Never destructive.
    Conflict(String),
}

/// Normalise a configured path and refuse the ones that do not name a
/// folder inside the worktree. A provisioned path is joined onto both
/// checkouts, so an absolute path, a `..` step, or git's own bookkeeping
/// would reach somewhere we have no business writing.
pub fn validate_entry_path(path: &str) -> Result<String, String> {
    let trimmed = path.trim().replace('\\', "/");
    if trimmed.is_empty() {
        return Err("A folder to prepare cannot be blank.".to_owned());
    }
    if trimmed.starts_with('-') {
        return Err(format!("Refusing a folder that looks like a flag: {path}"));
    }
    if trimmed.starts_with('/') || starts_with_drive(&trimmed) {
        return Err(format!("A folder to prepare must be relative: {path}"));
    }
    let segments: Vec<&str> = trimmed.split('/').filter(|s| !s.is_empty()).collect();
    if segments.contains(&"..") {
        return Err(format!("A folder to prepare cannot step outside with '..': {path}"));
    }
    if segments.first() == Some(&".git") {
        return Err("Git's own folder is never prepared.".to_owned());
    }
    Ok(segments.join("/"))
}

/// `C:/x` — a Windows absolute path even when spelled with slashes.
fn starts_with_drive(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

/// What to do about one entry, given what is on the disk at both ends.
///
/// Two rules run through the whole table. Nothing that already holds
/// data is deleted — an occupied target is a `Conflict` the user
/// resolves, never something we clear. And a link we did not make is
/// left exactly as it is, because rewiring it would silently move where
/// someone else's build reads from.
pub fn plan_step(
    source: &PathKind,
    target: &PathKind,
    strategy: ProvisionStrategy,
    source_path: &str,
) -> PlanStep {
    if strategy == ProvisionStrategy::Skip {
        return PlanStep::Skip("Not prepared, by choice.".to_owned());
    }
    if matches!(source, PathKind::Missing) {
        return PlanStep::Skip(format!("The main checkout has no {source_path}."));
    }
    if !matches!(source, PathKind::Dir { .. }) {
        return PlanStep::Conflict(format!("{source_path} is not a folder in the main checkout."));
    }

    let share = strategy == ProvisionStrategy::Share;
    match target {
        PathKind::Missing => {
            if share {
                PlanStep::Link
            } else {
                PlanStep::Copy
            }
        }
        PathKind::SymlinkTo(dest) if share && same_path(dest, source_path) => {
            PlanStep::AlreadyProvisioned
        }
        PathKind::SymlinkTo(dest) => {
            PlanStep::Conflict(format!("Already linked to {dest}. Remove it first."))
        }
        PathKind::Dir { empty: true } => {
            if share {
                PlanStep::ClearThenLink
            } else {
                PlanStep::ClearThenCopy
            }
        }
        PathKind::Dir { empty: false } => {
            PlanStep::Conflict("Already has contents. Remove it first.".to_owned())
        }
        PathKind::File => PlanStep::Conflict("A file is in the way.".to_owned()),
    }
}

/// Whether removing this entry is safe to do ourselves. Only a symlink
/// is: unlinking one removes the link and never what it points at. A
/// real directory belongs to the worktree and is git's to delete.
pub fn should_unlink(kind: &PathKind) -> bool {
    matches!(kind, PathKind::SymlinkTo(_))
}

fn same_path(a: &str, b: &str) -> bool {
    let norm = |p: &str| p.replace('\\', "/").trim_end_matches('/').to_lowercase();
    norm(a) == norm(b)
}

/// The argv for `git worktree remove`. Pure so the shape of the command
/// — especially where `--force` does and does not appear — is a unit
/// test rather than something only a real repository can prove.
pub fn remove_args(worktree_path: &str, mode: &str) -> Result<Vec<String>, String> {
    if worktree_path.starts_with('-') {
        return Err(format!("Refusing a suspicious worktree path: {worktree_path}"));
    }
    let mut args = vec!["worktree".to_owned(), "remove".to_owned()];
    match mode {
        "safe" => {}
        // Once, never twice: `--force --force` also removes a *locked*
        // worktree, which usually means removable media or another
        // machine. That is a decision to take in git, not by accident.
        "force" => args.push("--force".to_owned()),
        other => return Err(format!("Unknown removal mode: {other}")),
    }
    args.push("--".to_owned());
    args.push(worktree_path.to_owned());
    Ok(args)
}

/// Whether a failed removal deserves another try in a moment.
///
/// Windows frees a directory only once every process that had it open
/// has fully exited, and a virus scanner or the search indexer can hold
/// a handle for a beat after that. Both report as the folder being busy
/// or not empty, and both are gone by the next attempt — unlike "you
/// have uncommitted work", which no amount of waiting fixes and which
/// must reach the user as the answer rather than as a delay.
pub fn removal_is_transient(error: &str) -> bool {
    const TRANSIENT: [&str; 6] = [
        "directory not empty",
        "access is denied",
        "permission denied",
        "being used by another process",
        "resource busy",
        "device or resource busy",
    ];
    let lowered = error.to_lowercase();
    TRANSIENT.iter().any(|needle| lowered.contains(needle))
}

/// One folder measured by the shell's walk, before roll-up.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RawEntry {
    pub path: String,
    /// Bytes the filesystem actually reserved.
    pub allocated: u64,
    /// Bytes the files claim to be.
    pub apparent: u64,
    /// True when this folder was shared or copied from the main checkout.
    pub shared: bool,
}

/// One line of the size breakdown.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageEntry {
    pub path: String,
    pub bytes: u64,
    pub shared: bool,
}

/// What a worktree costs.
///
/// `own_bytes` and `shared_bytes` split by provenance, not by measuring
/// which extents are really shared: a copy-on-write clone costs almost
/// nothing but every filesystem that can make one still reports it at
/// full size. Recording which folders we linked or cloned is the honest
/// answer available; claiming to have measured sharing would not be.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiskUsage {
    pub own_bytes: u64,
    pub shared_bytes: u64,
    pub apparent_bytes: u64,
    pub entries: Vec<UsageEntry>,
    /// The walk stopped early; every number is a lower bound.
    pub truncated: bool,
}

/// How many folders the breakdown names before it stops being a summary.
pub const MAX_USAGE_ENTRIES: usize = 10;

/// Total the walk and keep the largest folders, biggest first.
pub fn roll_up(entries: &[RawEntry], truncated: bool) -> DiskUsage {
    let mut own_bytes = 0;
    let mut shared_bytes = 0;
    let mut apparent_bytes = 0;
    for entry in entries {
        apparent_bytes += entry.apparent;
        if entry.shared {
            shared_bytes += entry.allocated;
        } else {
            own_bytes += entry.allocated;
        }
    }

    let mut lines: Vec<UsageEntry> = entries
        .iter()
        .map(|e| UsageEntry { path: e.path.clone(), bytes: e.allocated, shared: e.shared })
        .collect();
    // Ties break by path so the list does not reshuffle between reads.
    lines.sort_by(|a, b| b.bytes.cmp(&a.bytes).then_with(|| a.path.cmp(&b.path)));
    let over = lines.len() > MAX_USAGE_ENTRIES;
    lines.truncate(MAX_USAGE_ENTRIES);

    DiskUsage {
        own_bytes,
        shared_bytes,
        apparent_bytes,
        entries: lines,
        truncated: truncated || over,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn dir() -> PathKind {
        PathKind::Dir { empty: false }
    }

    #[test]
    fn a_busy_folder_is_worth_retrying() {
        // The exact wording git prints on Windows when a process that
        // had the worktree open has not finished exiting.
        assert!(removal_is_transient(
            "failed to delete 'G:/wks/art-8106': Directory not empty"
        ));
        assert!(removal_is_transient("Access is denied. (os error 5)"));
        assert!(removal_is_transient(
            "The process cannot access the file because it is being used by another process."
        ));
        assert!(removal_is_transient("Resource busy"));
    }

    #[test]
    fn a_refusal_to_discard_work_is_not_retried() {
        // Waiting does not make these true, and retrying only delays the
        // message the user needs to read.
        assert!(!removal_is_transient(
            "'art-8106' contains modified or untracked files, use --force to delete it"
        ));
        assert!(!removal_is_transient("is not a working tree"));
        assert!(!removal_is_transient("is a main working tree"));
        assert!(!removal_is_transient(""));
    }

    #[test]
    fn an_ordinary_relative_folder_is_kept() {
        assert_eq!(validate_entry_path("node_modules").unwrap(), "node_modules");
        assert_eq!(validate_entry_path("src-tauri/target").unwrap(), "src-tauri/target");
    }

    #[test]
    fn backslashes_and_stray_separators_normalise() {
        assert_eq!(validate_entry_path("src-tauri\\target\\").unwrap(), "src-tauri/target");
        assert_eq!(validate_entry_path("  a//b  ").unwrap(), "a/b");
    }

    #[test]
    fn a_blank_folder_is_refused() {
        assert!(validate_entry_path("").is_err());
        assert!(validate_entry_path("   ").is_err());
    }

    #[test]
    fn an_absolute_path_is_refused_in_either_spelling() {
        assert!(validate_entry_path("/etc").is_err());
        assert!(validate_entry_path("C:\\Windows").is_err());
        assert!(validate_entry_path("C:/Windows").is_err());
    }

    #[test]
    fn stepping_outside_is_refused_anywhere_in_the_path() {
        assert!(validate_entry_path("../escape").is_err());
        assert!(validate_entry_path("a/../../b").is_err());
    }

    #[test]
    fn gits_own_folder_is_refused() {
        assert!(validate_entry_path(".git").is_err());
        assert!(validate_entry_path(".git/config").is_err());
        // A folder that merely starts with the same letters is fine.
        assert!(validate_entry_path(".gitmodules-cache").is_ok());
    }

    #[test]
    fn a_folder_that_looks_like_a_flag_is_refused() {
        assert!(validate_entry_path("-rf").is_err());
    }

    #[test]
    fn skip_does_nothing_whatever_the_disk_holds() {
        let step = plan_step(&dir(), &PathKind::Missing, ProvisionStrategy::Skip, "node_modules");
        assert!(matches!(step, PlanStep::Skip(_)));
    }

    #[test]
    fn a_source_the_main_checkout_lacks_is_skipped_not_failed() {
        let step = plan_step(
            &PathKind::Missing,
            &PathKind::Missing,
            ProvisionStrategy::Clone,
            "node_modules",
        );
        match step {
            PlanStep::Skip(why) => assert!(why.contains("node_modules")),
            other => panic!("expected Skip, got {other:?}"),
        }
    }

    #[test]
    fn a_missing_target_is_linked_or_copied_by_strategy() {
        assert_eq!(
            plan_step(&dir(), &PathKind::Missing, ProvisionStrategy::Share, "target"),
            PlanStep::Link
        );
        assert_eq!(
            plan_step(&dir(), &PathKind::Missing, ProvisionStrategy::Clone, "target"),
            PlanStep::Copy
        );
    }

    #[test]
    fn a_link_that_already_points_at_the_source_is_a_no_op() {
        let target = PathKind::SymlinkTo("/repos/app/target".to_owned());
        assert_eq!(
            plan_step(&dir(), &target, ProvisionStrategy::Share, "/repos/app/target"),
            PlanStep::AlreadyProvisioned
        );
    }

    #[test]
    fn the_no_op_check_tolerates_the_separators_git_and_the_os_disagree_on() {
        let target = PathKind::SymlinkTo("C:/repos/app/target".to_owned());
        assert_eq!(
            plan_step(&dir(), &target, ProvisionStrategy::Share, "C:\\repos\\app\\target"),
            PlanStep::AlreadyProvisioned
        );
    }

    #[test]
    fn a_link_pointing_elsewhere_is_a_conflict_never_a_rewire() {
        let target = PathKind::SymlinkTo("/somewhere/else".to_owned());
        match plan_step(&dir(), &target, ProvisionStrategy::Share, "/repos/app/target") {
            PlanStep::Conflict(why) => assert!(why.contains("/somewhere/else")),
            other => panic!("expected Conflict, got {other:?}"),
        }
    }

    #[test]
    fn a_link_is_never_replaced_by_a_copy_either() {
        let target = PathKind::SymlinkTo("/repos/app/target".to_owned());
        assert!(matches!(
            plan_step(&dir(), &target, ProvisionStrategy::Clone, "/repos/app/target"),
            PlanStep::Conflict(_)
        ));
    }

    #[test]
    fn an_empty_directory_in_the_way_is_cleared_first() {
        let empty = PathKind::Dir { empty: true };
        assert_eq!(
            plan_step(&dir(), &empty, ProvisionStrategy::Share, "target"),
            PlanStep::ClearThenLink
        );
        assert_eq!(
            plan_step(&dir(), &empty, ProvisionStrategy::Clone, "target"),
            PlanStep::ClearThenCopy
        );
    }

    #[test]
    fn a_directory_with_contents_is_never_deleted() {
        for strategy in [ProvisionStrategy::Share, ProvisionStrategy::Clone] {
            assert!(matches!(
                plan_step(&dir(), &dir(), strategy, "node_modules"),
                PlanStep::Conflict(_)
            ));
        }
    }

    #[test]
    fn a_file_in_the_way_is_a_conflict() {
        assert!(matches!(
            plan_step(&dir(), &PathKind::File, ProvisionStrategy::Clone, "target"),
            PlanStep::Conflict(_)
        ));
    }

    #[test]
    fn a_source_that_is_not_a_folder_is_a_conflict() {
        assert!(matches!(
            plan_step(&PathKind::File, &PathKind::Missing, ProvisionStrategy::Clone, "target"),
            PlanStep::Conflict(_)
        ));
    }

    #[test]
    fn only_a_symlink_is_ours_to_remove() {
        assert!(should_unlink(&PathKind::SymlinkTo("/anywhere".to_owned())));
        assert!(!should_unlink(&dir()));
        assert!(!should_unlink(&PathKind::Dir { empty: true }));
        assert!(!should_unlink(&PathKind::File));
        assert!(!should_unlink(&PathKind::Missing));
    }

    #[test]
    fn safe_removal_passes_no_force_and_ends_the_options() {
        assert_eq!(
            remove_args("/repos/app-worktrees/dev", "safe").unwrap(),
            ["worktree", "remove", "--", "/repos/app-worktrees/dev"]
        );
    }

    #[test]
    fn forced_removal_adds_the_flag_exactly_once() {
        let args = remove_args("/repos/app-worktrees/dev", "force").unwrap();
        assert_eq!(args.iter().filter(|a| *a == "--force").count(), 1);
        assert_eq!(args[2], "--force");
    }

    #[test]
    fn a_path_that_looks_like_a_flag_is_refused() {
        assert!(remove_args("--git-dir=/etc", "safe").is_err());
    }

    #[test]
    fn an_unknown_mode_is_refused_rather_than_defaulted() {
        assert!(remove_args("/repos/app-worktrees/dev", "").is_err());
        assert!(remove_args("/repos/app-worktrees/dev", "FORCE").is_err());
    }

    fn raw(path: &str, allocated: u64, shared: bool) -> RawEntry {
        RawEntry { path: path.to_owned(), allocated, apparent: allocated + 1, shared }
    }

    #[test]
    fn totals_split_by_provenance() {
        let usage = roll_up(&[raw("src", 100, false), raw("node_modules", 900, true)], false);
        assert_eq!(usage.own_bytes, 100);
        assert_eq!(usage.shared_bytes, 900);
        assert_eq!(usage.apparent_bytes, 1002);
    }

    #[test]
    fn an_empty_worktree_reports_zero_rather_than_an_error() {
        let usage = roll_up(&[], false);
        assert_eq!(usage.own_bytes, 0);
        assert_eq!(usage.shared_bytes, 0);
        assert!(usage.entries.is_empty());
        assert!(!usage.truncated);
    }

    #[test]
    fn the_breakdown_is_largest_first() {
        let usage = roll_up(&[raw("a", 1, false), raw("b", 9, false), raw("c", 5, false)], false);
        let paths: Vec<&str> = usage.entries.iter().map(|e| e.path.as_str()).collect();
        assert_eq!(paths, ["b", "c", "a"]);
    }

    #[test]
    fn a_long_breakdown_is_capped_and_says_so() {
        let entries: Vec<RawEntry> =
            (0..15u64).map(|n| raw(&format!("d{n:02}"), n, false)).collect();
        let usage = roll_up(&entries, false);
        assert_eq!(usage.entries.len(), MAX_USAGE_ENTRIES);
        assert!(usage.truncated);
        // Capping the list never loses bytes from the total.
        assert_eq!(usage.own_bytes, (0..15u64).sum::<u64>());
    }

    #[test]
    fn a_truncated_walk_stays_truncated() {
        assert!(roll_up(&[raw("a", 1, false)], true).truncated);
    }
}
