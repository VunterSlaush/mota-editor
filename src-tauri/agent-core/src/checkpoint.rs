//! Checkpoints — the pure half of `/rewind`.
//!
//! A checkpoint is an ordinary git commit built from a throwaway index,
//! so taking one never touches the user's index, HEAD, or branch. This
//! module decides the argv and interprets the output; the shell runs git.

use serde::Serialize;

/// Where the checkpoint chain is anchored. One ref per session, each
/// checkpoint parented on the one before it, so a single ref keeps the
/// whole chain reachable and safe from `git gc`.
pub const REF_PREFIX: &str = "refs/mota/checkpoints/";

/// The message on every checkpoint commit. These commits are never on a
/// branch, so this is only ever seen by someone reading the ref by hand.
pub const COMMIT_MESSAGE: &str = "mota checkpoint";

/// The ref a session's checkpoints hang from.
///
/// A session id reaches us from the agent, and git refs have their own
/// grammar (no spaces, no `..`, no `~^:?*[`, no leading or trailing
/// dot). Rather than validate and reject, replace anything outside a
/// known-safe alphabet: a mangled id still gives a stable, unique,
/// harmless ref name.
pub fn ref_name(session_id: &str) -> String {
    let safe: String = session_id
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '-'
            }
        })
        .collect();
    let trimmed = safe.trim_matches('-');
    if trimmed.is_empty() {
        format!("{REF_PREFIX}session")
    } else {
        format!("{REF_PREFIX}{trimmed}")
    }
}

/// The argv sequences that build a checkpoint's tree, in order, all run
/// against a throwaway `GIT_INDEX_FILE`.
///
/// Seeding the temp index from the parent commit is what keeps this
/// cheap: `add -A` then only has to stat what changed instead of hashing
/// the whole work tree. With no parent (a repository with no commits)
/// the index starts empty and `add -A` does the full pass once.
pub fn tree_steps(parent: Option<&str>) -> Vec<Vec<String>> {
    let mut steps = Vec::new();
    if let Some(parent) = parent {
        steps.push(vec!["read-tree".to_owned(), parent.to_owned()]);
    }
    steps.push(vec!["add".to_owned(), "-A".to_owned()]);
    steps.push(vec!["write-tree".to_owned()]);
    steps
}

/// Turn a tree into a commit, chained onto the previous checkpoint.
pub fn commit_tree_args(tree: &str, parent: Option<&str>) -> Vec<String> {
    let mut args = vec!["commit-tree".to_owned(), tree.to_owned()];
    if let Some(parent) = parent {
        args.push("-p".to_owned());
        args.push(parent.to_owned());
    }
    args.push("-m".to_owned());
    args.push(COMMIT_MESSAGE.to_owned());
    args
}

/// Compare a checkpoint against a tree of how things are now.
///
/// Both sides are trees on purpose. Diffing a commit against the *work
/// tree* silently omits untracked files, so a file the agent created
/// would not be reported as added and would survive a rewind — the one
/// failure mode where the user is told the code went back and it did
/// not. Staging the present into a throwaway index first puts both
/// sides through the same `add -A`, and the comparison is symmetric.
///
/// `--no-renames` is load-bearing: with rename detection on, git reports
/// `R old new` and the two paths have opposite fates, which is exactly
/// the kind of subtlety a delete path should not carry. `-z` is the
/// other half — without it git quotes and octal-escapes any path with a
/// space or a non-ASCII character.
pub fn diff_args(commit: &str, now: &str) -> Vec<String> {
    vec![
        "diff".to_owned(),
        "--name-status".to_owned(),
        "--no-renames".to_owned(),
        "-z".to_owned(),
        commit.to_owned(),
        now.to_owned(),
    ]
}

/// Line counts for the same comparison. `--shortstat` carries no paths
/// at all, which is why it is asked separately: no quoting to undo.
pub fn shortstat_args(commit: &str, now: &str) -> Vec<String> {
    vec![
        "diff".to_owned(),
        "--shortstat".to_owned(),
        "--no-renames".to_owned(),
        commit.to_owned(),
        now.to_owned(),
    ]
}

/// One file's diff between the checkpoint and now, for the viewer.
pub fn file_diff_args(commit: &str, now: &str, path: &str) -> Vec<String> {
    vec![
        "diff".to_owned(),
        "--no-renames".to_owned(),
        commit.to_owned(),
        now.to_owned(),
        // After `--` so a file named like a revision cannot be read as one.
        "--".to_owned(),
        path.to_owned(),
    ]
}

/// What rewinding will do to one path.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Fate {
    /// Write the checkpoint's copy back over what is there now.
    Restore,
    /// Remove it — it did not exist at the checkpoint.
    Delete,
}

/// One path that differs between a checkpoint and the work tree.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckpointChange {
    pub path: String,
    pub fate: Fate,
    /// What happened to it since the checkpoint, for the confirm dialog:
    /// added, deleted, modified.
    pub label: String,
}

/// Parse `git diff --name-status --no-renames -z` output: a flat run of
/// NUL-terminated fields, alternating status and path.
pub fn parse_name_status(text: &str) -> Vec<CheckpointChange> {
    let mut fields = text.split('\0').filter(|f| !f.is_empty());
    let mut changes = Vec::new();
    while let (Some(status), Some(path)) = (fields.next(), fields.next()) {
        changes.push(change_for(status, path));
    }
    changes
}

/// Statuses are relative to the checkpoint, so they read backwards from
/// what rewinding does: a file `A`dded since then is the one that has to
/// go. Anything unrecognised restores rather than deletes — an unknown
/// status is a reason to write a file, never a reason to remove one.
fn change_for(status: &str, path: &str) -> CheckpointChange {
    let (fate, label) = match status.chars().next() {
        Some('A') => (Fate::Delete, "added"),
        Some('D') => (Fate::Restore, "deleted"),
        Some('M') => (Fate::Restore, "modified"),
        Some('T') => (Fate::Restore, "type changed"),
        _ => (Fate::Restore, "changed"),
    };
    CheckpointChange {
        path: path.to_owned(),
        fate,
        label: label.to_owned(),
    }
}

/// The two lists a rewind acts on. Only paths git itself named appear
/// here, so a restore can never reach a file the diff did not mention.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct RestorePlan {
    pub restore: Vec<String>,
    pub delete: Vec<String>,
}

pub fn restore_plan(changes: &[CheckpointChange]) -> RestorePlan {
    let mut plan = RestorePlan::default();
    for change in changes {
        match change.fate {
            Fate::Restore => plan.restore.push(change.path.clone()),
            Fate::Delete => plan.delete.push(change.path.clone()),
        }
    }
    plan
}

/// How much a rewind would change, for the confirm dialog.
#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffStat {
    pub files: u32,
    pub insertions: u32,
    pub deletions: u32,
}

/// Parse `git diff --shortstat`:
/// ` 3 files changed, 12 insertions(+), 4 deletions(-)`.
/// Any of the three clauses can be absent — a pure-deletion diff has no
/// insertions clause — and an unchanged tree prints nothing at all.
pub fn parse_shortstat(text: &str) -> DiffStat {
    let mut stat = DiffStat::default();
    for clause in text.trim().split(',') {
        let mut words = clause.split_whitespace();
        let Some(count) = words.next().and_then(|n| n.parse::<u32>().ok()) else {
            continue;
        };
        match words.next() {
            Some(word) if word.starts_with("file") => stat.files = count,
            Some(word) if word.starts_with("insertion") => stat.insertions = count,
            Some(word) if word.starts_with("deletion") => stat.deletions = count,
            _ => {}
        }
    }
    stat
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ref_name_survives_a_hostile_session_id() {
        assert_eq!(
            ref_name("../../HEAD~1"),
            "refs/mota/checkpoints/HEAD-1",
            "path and revision syntax must not survive into a ref name"
        );
        assert_eq!(ref_name(""), "refs/mota/checkpoints/session");
        assert_eq!(ref_name("---"), "refs/mota/checkpoints/session");
        assert_eq!(
            ref_name("9f3a-11ee_b2"),
            "refs/mota/checkpoints/9f3a-11ee_b2"
        );
    }

    #[test]
    fn a_repo_with_commits_seeds_the_temp_index() {
        let steps = tree_steps(Some("abc123"));
        assert_eq!(steps[0], vec!["read-tree", "abc123"]);
        assert_eq!(steps[1], vec!["add", "-A"]);
        assert_eq!(steps[2], vec!["write-tree"]);
    }

    #[test]
    fn an_empty_repo_starts_from_an_empty_index() {
        let steps = tree_steps(None);
        assert_eq!(steps.len(), 2, "nothing to seed from");
        assert_eq!(steps[0], vec!["add", "-A"]);
    }

    #[test]
    fn the_first_checkpoint_has_no_parent() {
        assert_eq!(
            commit_tree_args("tree1", None),
            vec!["commit-tree", "tree1", "-m", COMMIT_MESSAGE]
        );
        assert_eq!(
            commit_tree_args("tree2", Some("commit1")),
            vec!["commit-tree", "tree2", "-p", "commit1", "-m", COMMIT_MESSAGE]
        );
    }

    #[test]
    fn renames_are_never_asked_for() {
        // A rename reported as one entry would pair a path to restore
        // with a path to delete, and the delete list is the dangerous
        // one. Two plain entries are unambiguous.
        assert!(diff_args("abc", "def").contains(&"--no-renames".to_owned()));
        assert!(diff_args("abc", "def").contains(&"-z".to_owned()));
    }

    #[test]
    fn both_sides_of_the_comparison_are_trees() {
        // Never `git diff <commit> --`: that compares against the work
        // tree, which does not know about untracked files, so a file the
        // agent created would not be reported as added and a rewind
        // would quietly leave it behind.
        let args = diff_args("checkpoint", "now");
        assert!(args.contains(&"now".to_owned()));
        assert!(!args.contains(&"--".to_owned()));
        assert!(shortstat_args("checkpoint", "now").contains(&"now".to_owned()));
    }

    #[test]
    fn a_file_diff_puts_the_path_behind_a_double_dash() {
        let args = file_diff_args("checkpoint", "now", "src/main.rs");
        let dashes = args.iter().position(|a| a == "--").expect("no --");
        assert_eq!(args[dashes + 1], "src/main.rs");
    }

    #[test]
    fn a_file_added_since_the_checkpoint_is_the_one_that_gets_deleted() {
        let changes = parse_name_status("M\0src/main.rs\0A\0src/new.rs\0D\0src/gone.rs\0");
        let plan = restore_plan(&changes);
        assert_eq!(plan.delete, vec!["src/new.rs"]);
        assert_eq!(plan.restore, vec!["src/main.rs", "src/gone.rs"]);
    }

    #[test]
    fn an_unknown_status_restores_rather_than_deletes() {
        let changes = parse_name_status("X\0src/odd.rs\0");
        assert_eq!(changes[0].fate, Fate::Restore);
        assert_eq!(restore_plan(&changes).delete, Vec::<String>::new());
    }

    #[test]
    fn paths_with_spaces_and_unicode_survive_the_nul_split() {
        let changes = parse_name_status("M\0src/my file \u{2014} v2.rs\0");
        assert_eq!(changes[0].path, "src/my file \u{2014} v2.rs");
    }

    #[test]
    fn nothing_changed_is_an_empty_plan_not_an_error() {
        assert_eq!(parse_name_status(""), Vec::new());
        assert_eq!(restore_plan(&[]), RestorePlan::default());
        assert_eq!(parse_shortstat(""), DiffStat::default());
    }

    #[test]
    fn shortstat_reads_the_clauses_it_finds() {
        assert_eq!(
            parse_shortstat(" 3 files changed, 12 insertions(+), 4 deletions(-)\n"),
            DiffStat {
                files: 3,
                insertions: 12,
                deletions: 4
            }
        );
        // A pure deletion prints no insertions clause at all.
        assert_eq!(
            parse_shortstat(" 1 file changed, 9 deletions(-)"),
            DiffStat {
                files: 1,
                insertions: 0,
                deletions: 9
            }
        );
    }
}
