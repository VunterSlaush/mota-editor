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

/// One local branch.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Branch {
    pub name: String,
    pub current: bool,
}

/// Parse `git branch --format=%(HEAD)%09%(refname:short)` output:
/// `*<TAB>name` for the current branch, ` <TAB>name` otherwise.
pub fn parse_branches(output: &str) -> Vec<Branch> {
    output
        .lines()
        .filter_map(|line| {
            let (head, name) = line.split_once('\t')?;
            let name = name.trim();
            (!name.is_empty()).then(|| Branch {
                name: name.to_owned(),
                current: head.trim() == "*",
            })
        })
        .collect()
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
        let out = "*\tmain\n \tfeature/panel\n \tfix-login\n";
        let branches = parse_branches(out);
        assert_eq!(branches.len(), 3);
        assert!(branches[0].current);
        assert_eq!(branches[0].name, "main");
        assert!(!branches[1].current);
        assert_eq!(branches[1].name, "feature/panel");
        assert!(parse_branches("").is_empty());
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
