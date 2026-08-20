//! Version-control status — pure parsing of `git status --porcelain`
//! output. The shell runs git; this module only interprets the text.

use std::collections::HashSet;

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
/// Locals come out first and remotes dedupe against them by name,
/// whatever order the refs arrived in — the caller sorts by commit date,
/// which interleaves `refs/heads` and `refs/remotes` freely. Remote
/// entries keep the branch's own name — `origin/fix-login` shows (and
/// checks out) as `fix-login`, which git resolves to a new tracking
/// branch. `origin/HEAD` is a pointer, not a branch, and is skipped.
///
/// A well-fetched repository has thousands of remote refs, so the
/// name-against-name comparison is a set: a scan per ref made opening
/// the branch picker quadratic in the size of the remote.
pub fn parse_branches(output: &str) -> Vec<Branch> {
    let mut locals: Vec<Branch> = Vec::new();
    let mut remotes: Vec<Branch> = Vec::new();
    let mut local_names: HashSet<String> = HashSet::new();
    let mut remote_names: HashSet<String> = HashSet::new();

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
            // The same branch on two remotes is one row; first one wins.
            if name == "HEAD" || name.is_empty() || !remote_names.insert(name.to_owned()) {
                continue;
            }
            remotes.push(Branch { name: name.to_owned(), current: false, remote: true });
        } else {
            local_names.insert(short.to_owned());
            locals.push(Branch {
                name: short.to_owned(),
                current: head == "*",
                remote: false,
            });
        }
    }

    remotes.retain(|remote| !local_names.contains(&remote.name));
    locals.extend(remotes);
    locals
}

/// One checkout of the repository, from `git worktree list --porcelain`.
/// `branch` is empty when the worktree is on a detached HEAD.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Worktree {
    pub path: String,
    pub branch: String,
    pub head: String,
    /// The main checkout — always the first entry git prints.
    pub main: bool,
    pub bare: bool,
    pub locked: bool,
    pub prunable: bool,
}

/// Parse `git worktree list --porcelain` output: blank-line-separated
/// entries of `worktree <path>`, `HEAD <sha>`, `branch <ref>`, plus the
/// bare/detached/locked/prunable markers (the latter two may carry a
/// reason after a space).
pub fn parse_worktrees(porcelain: &str) -> Vec<Worktree> {
    let mut worktrees: Vec<Worktree> = Vec::new();
    for entry in porcelain.split("\n\n") {
        let mut path = String::new();
        let mut branch = String::new();
        let mut head = String::new();
        let (mut bare, mut locked, mut prunable) = (false, false, false);
        for line in entry.lines() {
            if let Some(rest) = line.strip_prefix("worktree ") {
                path = rest.trim().to_owned();
            } else if let Some(rest) = line.strip_prefix("HEAD ") {
                head = rest.trim().to_owned();
            } else if let Some(rest) = line.strip_prefix("branch ") {
                branch = rest.trim().strip_prefix("refs/heads/").unwrap_or(rest.trim()).to_owned();
            } else if line == "bare" {
                bare = true;
            } else if line == "locked" || line.starts_with("locked ") {
                locked = true;
            } else if line == "prunable" || line.starts_with("prunable ") {
                prunable = true;
            }
        }
        if path.is_empty() {
            continue;
        }
        let main = worktrees.is_empty();
        worktrees.push(Worktree { path, branch, head, main, bare, locked, prunable });
    }
    worktrees
}

/// How far the current branch has drifted from the branch it tracks:
/// what a pull would bring down, and what a push would send up.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Divergence {
    /// Commits on the upstream that this branch does not have.
    pub behind: u32,
    /// Commits here that the upstream does not have.
    pub ahead: u32,
}

/// Parse `git rev-list --left-right --count @{upstream}...HEAD`, which
/// prints the two counts on one tab-separated line: upstream-only first
/// (behind), HEAD-only second (ahead).
///
/// None for anything else — a branch with no upstream makes git fail
/// before it prints, and a shape we don't recognise is not worth
/// guessing at when the answer is a number shown to the user.
pub fn parse_ahead_behind(output: &str) -> Option<Divergence> {
    let line = output.lines().next()?;
    let (behind, ahead) = line.trim().split_once(|c: char| c.is_whitespace())?;
    Some(Divergence {
        behind: behind.trim().parse().ok()?,
        ahead: ahead.trim().parse().ok()?,
    })
}

/// A repository bigger than this is fine; the composer's "@" menu shows
/// fifty rows, so the rest would only cost bandwidth crossing to the UI.
pub const MAX_PROJECT_FILES: usize = 20_000;

/// Parse `git ls-files -z` output: NUL-separated paths which, unlike the
/// default output, are never quoted or octal-escaped. Deduped (a path can
/// be listed twice during a merge) and capped.
pub fn parse_ls_files(output: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    output
        .split('\0')
        .filter(|path| !path.is_empty())
        .filter(|path| seen.insert(path.to_owned()))
        .take(MAX_PROJECT_FILES)
        .map(str::to_owned)
        .collect()
}

/// How to throw away one file's unstaged changes.
///
/// The two halves of "not staged" need opposite verbs: a tracked file is
/// *restored* from the index, an untracked one has never been in the
/// index and can only be *removed*. Getting that backwards would either
/// do nothing or delete the wrong thing, so it is decided here, in the
/// open, and tested.
///
/// `--` before the path is not optional: a file named like a branch
/// would otherwise be read as one.
pub fn discard_file_args(path: &str, tracked: bool) -> Vec<String> {
    if tracked {
        vec!["restore".to_owned(), "--".to_owned(), path.to_owned()]
    } else {
        vec![
            "clean".to_owned(),
            "-f".to_owned(),
            "--".to_owned(),
            path.to_owned(),
        ]
    }
}

/// Throw away every unstaged change, in the same two halves.
///
/// `restore` takes the work tree back to the INDEX, not to HEAD, so
/// anything already staged survives — which is what "discard the changes
/// that are not staged" has to mean.
///
/// `clean -fd` removes untracked files and the directories that held
/// them. Deliberately **no `-x`**: ignored files are `.env`,
/// `node_modules/`, build output — things git was told to leave alone,
/// and nothing a "discard my edits" button should be able to destroy.
pub fn discard_all_restore_args() -> Vec<String> {
    vec!["restore".to_owned(), "--".to_owned(), ".".to_owned()]
}

pub fn discard_all_clean_args() -> Vec<String> {
    vec!["clean".to_owned(), "-f".to_owned(), "-d".to_owned()]
}

/// Why a git command failed, said first in words the user can act on,
/// with git's own output kept underneath.
///
/// git explains itself to someone who already knows git: the sentence
/// that names the fix is a `hint:` several lines below the failure, and
/// a rejected push shows the mechanics of refs before it shows the
/// problem. The panel has room for a few lines, so those lines have to
/// be the ones that mean something — a lead sentence we recognise the
/// case from, then what git said, minus the general-case advice.
pub fn explain_failure(stderr: &str) -> String {
    let detail = significant_lines(stderr, 4);
    match (plain_cause(stderr), detail.is_empty()) {
        (Some(cause), true) => cause.to_owned(),
        (Some(cause), false) => format!("{cause}\n\n{detail}"),
        (None, true) => "git failed without an error message.".to_owned(),
        (None, false) => detail,
    }
}

/// The failures worth naming — every one of them is a thing the user
/// then has to do something about, and the doing is what the sentence
/// says. Ordered by specificity: an authentication failure also mentions
/// the URL it could not reach, and would otherwise read as a network
/// problem.
fn plain_cause(stderr: &str) -> Option<&'static str> {
    let text = stderr.to_lowercase();
    let says = |needle: &str| text.contains(needle);

    if says("not a git repository") {
        Some("This folder is not a git repository.")
    } else if says("index.lock") || says("another git process") {
        Some("Another git process is using this repository. Wait for it to finish, then try again.")
    } else if says("could not read username")
        || says("authentication failed")
        || says("permission denied (publickey)")
        || says("terminal prompts disabled")
    {
        Some(
            "Git could not sign in to the remote. Mota never asks for credentials, so this has to be a credential helper or an SSH key on your machine.",
        )
    } else if says("could not resolve host")
        || says("connection timed out")
        || says("could not connect")
    {
        Some("The remote could not be reached. Check your network, then try again.")
    } else if says("does not appear to be a git repository") {
        Some("The address configured for this remote is not a repository git can read.")
    } else if says("non-fast-forward") || says("fetch first") || says("[rejected]") {
        Some("The remote has commits this branch does not. Pull first, then push again.")
    } else if says("no upstream branch") || says("no upstream configured") {
        Some(
            "This branch tracks no remote branch, so git does not know where to send it. Push it once from a terminal with `git push -u origin <branch>`.",
        )
    } else if says("divergent branches") || says("need to specify how to reconcile") {
        Some(
            "This branch and its upstream have both moved on, and git has no rule here for which to keep. Set `pull.rebase` to true or false, then pull again.",
        )
    } else if says("would be overwritten") || says("local changes") {
        Some("Uncommitted changes are in the way. Commit or stash them first.")
    } else if says("conflict") {
        Some("The merge stopped with conflicts. Resolve the marked files, then commit.")
    } else if says("nothing to commit") || says("no changes added to commit") {
        Some("Nothing is staged, so there is nothing to commit.")
    } else if says("please tell me who you are") || says("unable to auto-detect email") {
        Some("Git does not know who you are yet. Set `user.name` and `user.email`, then commit again.")
    } else {
        None
    }
}

/// git's own words, worst-case a wall of them: keep the last few, and
/// drop the `hint:` block when there is anything else — it explains the
/// general case at length, which is exactly what the lead sentence above
/// already did in one line.
fn significant_lines(stderr: &str, limit: usize) -> String {
    let all: Vec<&str> = stderr
        .lines()
        .map(str::trim_end)
        .filter(|line| !line.trim().is_empty())
        .collect();
    let loud: Vec<&str> = all
        .iter()
        .copied()
        .filter(|line| !line.trim_start().to_lowercase().starts_with("hint:"))
        .collect();
    let kept = if loud.is_empty() { &all } else { &loud };
    kept[kept.len().saturating_sub(limit)..].join("\n")
}

/// Whether git refused to diff this file as text.
///
/// git decides that on a NUL byte in the first 8000 of the file, which
/// is true of a PNG and equally true of a source file with a `"\0"`
/// literal in it — so this is a question about git's answer, never
/// about the file.
pub fn reported_as_binary(diff: &str) -> bool {
    diff.lines()
        .any(|line| line.starts_with("Binary files ") || line.starts_with("GIT binary patch"))
}

/// Whether a diff taken with `--text` is worth putting on screen.
///
/// Forcing text out of a real binary produces a screenful of noise, so
/// the content has to answer for itself: bytes that were not valid
/// UTF-8 reached us as replacement characters, and control characters
/// that text does not use are counted with them. A stray NUL or two in
/// a source file stays far under the ceiling; a JPEG never does.
pub fn is_displayable_text(diff: &str) -> bool {
    let total = diff.chars().count();
    let noise = diff.chars().filter(|c| is_noise(*c)).count();
    noise <= TOLERATED_NOISE_CHARS || noise * 100 <= total
}

/// The handful a deliberate `"\0"` puts in a one-line change, where a
/// share of the whole would be too tight to measure.
const TOLERATED_NOISE_CHARS: usize = 8;

fn is_noise(c: char) -> bool {
    c == char::REPLACEMENT_CHARACTER
        || (c.is_control() && c != '\n' && c != '\r' && c != '\t')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_tracked_file_is_restored_and_an_untracked_one_removed() {
        assert_eq!(
            discard_file_args("src/main.rs", true),
            vec!["restore", "--", "src/main.rs"]
        );
        assert_eq!(
            discard_file_args("src/new.rs", false),
            vec!["clean", "-f", "--", "src/new.rs"]
        );
    }

    #[test]
    fn a_path_is_always_behind_a_double_dash() {
        // Otherwise a file named like a branch is read as a revision.
        for args in [
            discard_file_args("main", true),
            discard_file_args("main", false),
            discard_all_restore_args(),
        ] {
            let dashes = args.iter().position(|a| a == "--").expect("no --");
            assert_eq!(args[dashes + 1], *args.last().unwrap());
        }
    }

    #[test]
    fn discarding_everything_never_reaches_ignored_files() {
        // `-x` would take .env, node_modules and every build cache with
        // it. A "discard my edits" button must not be able to do that.
        let args = discard_all_clean_args();
        assert!(!args.contains(&"-x".to_owned()), "{args:?}");
        assert!(!args.contains(&"-X".to_owned()), "{args:?}");
        assert_eq!(args, vec!["clean", "-f", "-d"]);
    }

    #[test]
    fn discarding_everything_restores_to_the_index_not_to_head() {
        // Staged work must survive: the section says "not staged".
        let args = discard_all_restore_args();
        assert!(!args.contains(&"--source".to_owned()), "{args:?}");
        assert!(!args.iter().any(|a| a.contains("HEAD")), "{args:?}");
        assert!(!args.contains(&"--staged".to_owned()), "{args:?}");
    }

    /// What git actually prints when a push is behind the remote — the
    /// case that started this: four lines of hints, and the reason above
    /// them where a `tail` never reached it.
    const REJECTED_PUSH: &str = concat!(
        "To github.com:someone/project.git\n",
        " ! [rejected]        main -> main (fetch first)\n",
        "error: failed to push some refs to 'github.com:someone/project.git'\n",
        "hint: Updates were rejected because the remote contains work that you do\n",
        "hint: not have locally. This is usually caused by another repository pushing\n",
        "hint: to the same ref. You may want to first integrate the remote changes\n",
        "hint: (e.g., 'git pull ...') before pushing again.\n",
    );

    #[test]
    fn a_rejected_push_leads_with_what_to_do() {
        let explained = explain_failure(REJECTED_PUSH);
        assert!(
            explained.starts_with("The remote has commits this branch does not."),
            "{explained}"
        );
    }

    #[test]
    fn a_rejected_push_keeps_gits_own_words_and_drops_its_hints() {
        let explained = explain_failure(REJECTED_PUSH);
        assert!(explained.contains("! [rejected]"), "{explained}");
        assert!(explained.contains("error: failed to push"), "{explained}");
        assert!(!explained.contains("hint:"), "{explained}");
    }

    #[test]
    fn an_authentication_failure_is_not_read_as_a_network_one() {
        let explained = explain_failure(
            "fatal: unable to access 'https://github.com/a/b.git/': The requested URL returned error: 403\nfatal: Authentication failed",
        );
        assert!(
            explained.starts_with("Git could not sign in"),
            "{explained}"
        );
    }

    #[test]
    fn a_branch_with_no_upstream_says_how_to_give_it_one() {
        let explained =
            explain_failure("fatal: The current branch feature has no upstream branch.");
        assert!(
            explained.starts_with("This branch tracks no remote branch"),
            "{explained}"
        );
    }

    #[test]
    fn a_pull_over_local_changes_says_to_commit_or_stash() {
        let explained = explain_failure(
            "error: Your local changes to the following files would be overwritten by merge:\n\tsrc/main.rs\nPlease commit your changes or stash them before you merge.",
        );
        assert!(
            explained.starts_with("Uncommitted changes are in the way."),
            "{explained}"
        );
    }

    #[test]
    fn a_failure_we_do_not_recognise_is_passed_on_whole() {
        let explained = explain_failure("fatal: something new and strange");
        assert_eq!(explained, "fatal: something new and strange");
    }

    #[test]
    fn hints_are_kept_when_they_are_all_there_is() {
        let explained = explain_failure("hint: try something else");
        assert_eq!(explained, "hint: try something else");
    }

    #[test]
    fn a_silent_failure_still_says_something() {
        assert_eq!(
            explain_failure("   \n\n"),
            "git failed without an error message."
        );
    }

    #[test]
    fn rev_list_counts_read_behind_then_ahead() {
        assert_eq!(
            parse_ahead_behind("2\t5\n"),
            Some(Divergence { behind: 2, ahead: 5 })
        );
    }

    #[test]
    fn a_branch_level_with_its_upstream_counts_zero() {
        assert_eq!(
            parse_ahead_behind("0\t0\n"),
            Some(Divergence { behind: 0, ahead: 0 })
        );
    }

    #[test]
    fn output_that_is_not_two_counts_is_no_answer() {
        assert_eq!(parse_ahead_behind(""), None);
        assert_eq!(parse_ahead_behind("fatal: no upstream\n"), None);
        assert_eq!(parse_ahead_behind("3\n"), None);
    }

    #[test]
    fn nul_separated_paths_become_entries() {
        let files = parse_ls_files("README.md\0src/main.rs\0docs/a b.md\0");
        assert_eq!(files, ["README.md", "src/main.rs", "docs/a b.md"]);
    }

    #[test]
    fn a_trailing_nul_does_not_add_an_empty_path() {
        assert_eq!(parse_ls_files("only.rs\0"), ["only.rs"]);
    }

    #[test]
    fn a_repeated_path_is_listed_once() {
        assert_eq!(parse_ls_files("a.rs\0a.rs\0b.rs\0"), ["a.rs", "b.rs"]);
    }

    #[test]
    fn an_oversized_repository_is_capped() {
        let out = (0..MAX_PROJECT_FILES + 10)
            .map(|i| format!("f{i}.rs\0"))
            .collect::<String>();
        assert_eq!(parse_ls_files(&out).len(), MAX_PROJECT_FILES);
    }

    #[test]
    fn empty_output_yields_no_paths() {
        assert!(parse_ls_files("").is_empty());
    }

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

    /// Sorting by commit date interleaves refs/heads and refs/remotes,
    /// so a remote may be read before the local branch tracking it.
    #[test]
    fn a_remote_listed_before_its_local_branch_still_dedupes() {
        let out = " \torigin/main\trefs/remotes/origin/main\n \
                    \torigin/fix-login\trefs/remotes/origin/fix-login\n \
                   *\tmain\trefs/heads/main\n";
        let branches = parse_branches(out);
        assert_eq!(branches.len(), 2);
        // Locals first, whatever order the refs arrived in.
        assert_eq!(branches[0].name, "main");
        assert!(branches[0].current);
        assert_eq!(branches[1].name, "fix-login");
        assert!(branches[1].remote);
    }

    #[test]
    fn the_same_branch_on_two_remotes_is_one_row() {
        let out = " \torigin/fix-login\trefs/remotes/origin/fix-login\n \
                    \tupstream/fix-login\trefs/remotes/upstream/fix-login\n";
        let branches = parse_branches(out);
        assert_eq!(branches.len(), 1);
        assert_eq!(branches[0].name, "fix-login");
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
    fn parses_main_and_linked_worktrees() {
        let out = "worktree /repos/mota editor\n\
                   HEAD abc1234def\n\
                   branch refs/heads/main\n\
                   \n\
                   worktree /repos/mota editor-worktrees/feature-login\n\
                   HEAD def5678abc\n\
                   branch refs/heads/feature/login\n";
        let wts = parse_worktrees(out);
        assert_eq!(wts.len(), 2);
        assert_eq!(wts[0].path, "/repos/mota editor");
        assert_eq!(wts[0].branch, "main");
        assert_eq!(wts[0].head, "abc1234def");
        assert!(wts[0].main);
        assert!(!wts[1].main);
        // The refs/heads/ prefix goes; the branch's own slashes stay.
        assert_eq!(wts[1].branch, "feature/login");
    }

    #[test]
    fn a_detached_worktree_has_an_empty_branch() {
        let out = "worktree /repos/app\n\
                   HEAD abc1234\n\
                   branch refs/heads/main\n\
                   \n\
                   worktree /repos/app-worktrees/spike\n\
                   HEAD def5678\n\
                   detached\n";
        let wts = parse_worktrees(out);
        assert_eq!(wts[1].branch, "");
        assert_eq!(wts[1].head, "def5678");
    }

    #[test]
    fn bare_locked_and_prunable_markers_are_read() {
        let out = "worktree /repos/store.git\n\
                   bare\n\
                   \n\
                   worktree /repos/store-worktrees/held\n\
                   HEAD abc\n\
                   branch refs/heads/held\n\
                   locked being used on another machine\n\
                   \n\
                   worktree /repos/store-worktrees/gone\n\
                   HEAD def\n\
                   branch refs/heads/gone\n\
                   prunable\n";
        let wts = parse_worktrees(out);
        assert!(wts[0].bare && wts[0].main);
        assert!(wts[1].locked && !wts[1].bare);
        assert!(wts[2].prunable && !wts[2].locked);
    }

    #[test]
    fn worktree_garbage_and_trailing_blanks_are_ignored() {
        assert!(parse_worktrees("").is_empty());
        assert!(parse_worktrees("\n\n").is_empty());
        let wts = parse_worktrees("worktree /only\nHEAD abc\nbranch refs/heads/main\n\n");
        assert_eq!(wts.len(), 1);
    }

    #[test]
    fn log_subjects_containing_tabs_keep_their_tail_in_when() {
        // splitn(4) keeps everything after the third tab in `when`.
        let commits = parse_log("aaa\tsubject\tauthor\t5 min ago\n\n");
        assert_eq!(commits.len(), 1);
        assert!(parse_log("").is_empty());
    }

    #[test]
    fn a_diff_git_would_not_show_as_text_is_recognised() {
        assert!(reported_as_binary(
            "diff --git a/app.tsx b/app.tsx\nBinary files a/app.tsx and b/app.tsx differ\n"
        ));
        assert!(reported_as_binary("GIT binary patch\ndelta 12\n"));
        assert!(!reported_as_binary("@@ -1 +1 @@\n-old\n+new\n"));
        // The phrase inside a changed line is a change, not a verdict.
        assert!(!reported_as_binary("@@ -1 +1 @@\n+Binary files differ\n"));
    }

    #[test]
    fn a_source_file_holding_a_nul_is_still_displayable() {
        let diff = format!("@@ -1 +1 @@\n-const separator = \"{}\";\n+const sep = \"|\";\n", '\0');
        assert!(is_displayable_text(&diff));
        assert!(is_displayable_text(""));
    }

    #[test]
    fn a_forced_binary_diff_is_not_displayable() {
        // What lossy decoding leaves of bytes that were never text.
        let noise: String = std::iter::repeat_n('\u{FFFD}', 40).collect();
        assert!(!is_displayable_text(&format!("@@ -1 +1 @@\n+{noise}\n")));
        // Every other byte a NUL — a UTF-16 file, which this cannot render.
        let utf16: String = "hello world".chars().flat_map(|c| [c, '\0']).collect();
        assert!(!is_displayable_text(&utf16));
    }
}
