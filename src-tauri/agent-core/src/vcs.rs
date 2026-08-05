//! Version-control status — pure parsing of `git status --porcelain`
//! output. The shell runs git; this module only interprets the text.

use serde::Serialize;

/// One changed file, as git reports it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    /// True when the change (or part of it) is in the index.
    pub staged: bool,
    /// True when the working tree differs from the index.
    pub unstaged: bool,
    /// Human-readable kind: modified, added, deleted, renamed, untracked, ...
    pub label: String,
}

/// Parse `git status --porcelain` (v1) output: lines of `XY path`,
/// where X is the index (staged) status and Y the worktree status.
pub fn parse_status(porcelain: &str) -> Vec<GitChange> {
    porcelain.lines().filter_map(parse_line).collect()
}

fn parse_line(line: &str) -> Option<GitChange> {
    let mut chars = line.chars();
    let index = chars.next()?;
    let worktree = chars.next()?;
    let path = line.get(3..)?.trim();
    if path.is_empty() {
        return None;
    }
    let path = rename_target(path);

    if index == '?' && worktree == '?' {
        return Some(GitChange {
            path,
            staged: false,
            unstaged: true,
            label: "untracked".to_owned(),
        });
    }
    Some(GitChange {
        path,
        staged: index != ' ' && index != '?',
        unstaged: worktree != ' ',
        label: label_for(if index != ' ' { index } else { worktree }),
    })
}

/// Renames are reported as `old -> new`; the new path is what matters.
fn rename_target(path: &str) -> String {
    path.rsplit_once(" -> ")
        .map(|(_, new)| new)
        .unwrap_or(path)
        .trim_matches('"')
        .to_owned()
}

fn label_for(status: char) -> String {
    match status {
        'M' => "modified",
        'A' => "added",
        'D' => "deleted",
        'R' => "renamed",
        'C' => "copied",
        'U' => "conflicted",
        _ => "changed",
    }
    .to_owned()
}

/// One commit from `git log`.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Commit {
    pub hash: String,
    pub subject: String,
    pub author: String,
    pub when: String,
}

/// Parse `git log --pretty=format:%h%x09%s%x09%an%x09%ar` output:
/// tab-separated short-hash, subject, author, relative date.
pub fn parse_log(output: &str) -> Vec<Commit> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(4, '\t');
            Some(Commit {
                hash: parts.next()?.trim().to_owned(),
                subject: parts.next()?.trim().to_owned(),
                author: parts.next().unwrap_or_default().trim().to_owned(),
                when: parts.next().unwrap_or_default().trim().to_owned(),
            })
        })
        .filter(|c| !c.hash.is_empty())
        .collect()
}

/// One checkout-able branch. `remote` marks a branch that exists only on
/// a remote so far — checking it out lets git create the local
/// tracking branch.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub current: bool,
    pub remote: bool,
}

/// Parse `git branch --all --format=%(HEAD)%09%(refname:short)%09%(refname)`
/// output: `*<TAB>short<TAB>refs/...` for the current branch, a space
/// instead of `*` otherwise.
///
/// Locals sort before remotes (refs/heads < refs/remotes), so a remote
/// branch already checked out locally dedupes against the local entry.
/// Remote entries keep the branch's own name — `origin/fix-login` shows
/// (and checks out) as `fix-login`, which git resolves to a new tracking
/// branch. `origin/HEAD` is a pointer, not a branch, and is skipped.
pub fn parse_branches(output: &str) -> Vec<Branch> {
    let mut branches: Vec<Branch> = Vec::new();
    for line in output.lines() {
        let mut parts = line.splitn(3, '\t');
        let head = parts.next().unwrap_or_default().trim();
        let short = parts.next().unwrap_or_default().trim();
        let full = parts.next().unwrap_or_default().trim();
        if short.is_empty() {
            continue;
        }
        if let Some(rest) = full.strip_prefix("refs/remotes/") {
            let Some((_, name)) = rest.split_once('/') else { continue };
            if name == "HEAD" || name.is_empty() {
                continue;
            }
            if branches.iter().any(|b| b.name == name) {
                continue;
            }
            branches.push(Branch { name: name.to_owned(), current: false, remote: true });
        } else {
            branches.push(Branch {
                name: short.to_owned(),
                current: head == "*",
                remote: false,
            });
        }
    }
    branches
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_staged_unstaged_and_untracked() {
        let out = "M  src/staged.rs\n M src/unstaged.rs\nMM src/both.rs\n?? new.txt\n";
        let changes = parse_status(out);
        assert_eq!(changes.len(), 4);

        assert!(changes[0].staged && !changes[0].unstaged);
        assert_eq!(changes[0].path, "src/staged.rs");

        assert!(!changes[1].staged && changes[1].unstaged);
        assert!(changes[2].staged && changes[2].unstaged);

        assert!(!changes[3].staged && changes[3].unstaged);
        assert_eq!(changes[3].label, "untracked");
    }

    #[test]
    fn renames_report_the_new_path() {
        let changes = parse_status("R  old_name.rs -> new_name.rs\n");
        assert_eq!(changes[0].path, "new_name.rs");
        assert_eq!(changes[0].label, "renamed");
        assert!(changes[0].staged);
    }

    #[test]
    fn added_and_deleted_are_labelled() {
        let changes = parse_status("A  brand_new.rs\nD  gone.rs\n");
        assert_eq!(changes[0].label, "added");
        assert_eq!(changes[1].label, "deleted");
    }

    #[test]
    fn empty_and_garbage_lines_are_ignored() {
        assert!(parse_status("").is_empty());
        assert!(parse_status("\n\nX\n").is_empty());
    }

    #[test]
    fn parses_branches_and_marks_the_current_one() {
        let out = "*\tmain\trefs/heads/main\n \
                   \tfeature/panel\trefs/heads/feature/panel\n \
                   \tfix-login\trefs/heads/fix-login\n";
        let branches = parse_branches(out);
        assert_eq!(branches.len(), 3);
        assert!(branches[0].current);
        assert_eq!(branches[0].name, "main");
        assert!(!branches[0].remote);
        assert!(!branches[1].current);
        assert_eq!(branches[1].name, "feature/panel");
        assert!(parse_branches("").is_empty());
    }

    #[test]
    fn remote_branches_show_without_their_remote_and_dedupe_against_locals() {
        let out = "*\tmain\trefs/heads/main\n \
                   \torigin\trefs/remotes/origin/HEAD\n \
                   \torigin/main\trefs/remotes/origin/main\n \
                   \torigin/fix-login\trefs/remotes/origin/fix-login\n";
        let branches = parse_branches(out);
        assert_eq!(branches.len(), 2);
        assert_eq!(branches[0].name, "main");
        assert!(!branches[0].remote);
        // The remote-only branch appears under its own name, marked remote.
        assert_eq!(branches[1].name, "fix-login");
        assert!(branches[1].remote);
        assert!(!branches[1].current);
    }

    #[test]
    fn parses_the_commit_log() {
        let out = "abc1234\tFix the login bug\tMota\t2 hours ago\n\
                   def5678\tAdd plan panel\tClaude\t3 days ago\n";
        let commits = parse_log(out);
        assert_eq!(commits.len(), 2);
        assert_eq!(commits[0].hash, "abc1234");
        assert_eq!(commits[0].subject, "Fix the login bug");
        assert_eq!(commits[0].author, "Mota");
        assert_eq!(commits[0].when, "2 hours ago");
    }

    #[test]
    fn log_subjects_containing_tabs_keep_their_tail_in_when() {
        // splitn(4) keeps everything after the third tab in `when`.
        let commits = parse_log("aaa\tsubject\tauthor\t5 min ago\n\n");
        assert_eq!(commits.len(), 1);
        assert!(parse_log("").is_empty());
    }
}
