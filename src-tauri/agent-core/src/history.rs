//! Reading the shell's own history file — the format, not the file.
//!
//! The user's most-run commands already exist on disk: the shell has
//! been recording them for as long as they have used it. Suggestions
//! seed from that rather than starting empty and learning for a week.
//!
//! Nothing here writes. The shell keeps its own history current,
//! including the commands typed in our terminal, so a second copy would
//! only be a second thing to get out of step.

/// How a shell lays its history file out.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HistoryFormat {
    /// One command per line. PSReadLine, bash.
    Plain,
    /// `: <started>:<elapsed>;<command>`, which zsh writes under
    /// `EXTENDED_HISTORY` and reads either way.
    ZshExtended,
}

/// The most this will hand back, newest last. Someone with a decade of
/// shell history has hundreds of thousands of lines, and the tail is
/// where anything they still run lives.
pub const MAX_ENTRIES: usize = 5000;

/// Split a history file into commands, newest last.
///
/// Multi-line entries are dropped rather than guessed at: a command
/// continued across lines cannot be replayed by prefix-completing a
/// single line, so keeping it would only add a suggestion that inserts
/// something the user did not type.
pub fn parse_history(text: &str, format: HistoryFormat) -> Vec<String> {
    let mut commands: Vec<String> = Vec::new();
    let mut in_continuation = false;
    for raw in text.lines() {
        let continues = raw.ends_with('\\');
        let part_of_multi_line = in_continuation || continues;
        in_continuation = continues;
        if part_of_multi_line {
            continue;
        }
        let line = match format {
            HistoryFormat::Plain => raw,
            HistoryFormat::ZshExtended => strip_zsh_prefix(raw),
        };
        let line = line.trim();
        if !line.is_empty() {
            commands.push(line.to_owned());
        }
    }
    if commands.len() > MAX_ENTRIES {
        commands.drain(..commands.len() - MAX_ENTRIES);
    }
    commands
}

/// `: 1699999999:0;git status` → `git status`. A line without the
/// marker is already a bare command — zsh only writes the prefix when
/// `EXTENDED_HISTORY` is on, and both shapes turn up in one file.
fn strip_zsh_prefix(line: &str) -> &str {
    let Some(rest) = line.strip_prefix(':') else { return line };
    match rest.split_once(';') {
        Some((stamp, command)) if is_stamp(stamp) => command,
        _ => line,
    }
}

fn is_stamp(stamp: &str) -> bool {
    let stamp = stamp.trim();
    let Some((started, elapsed)) = stamp.split_once(':') else { return false };
    !started.is_empty()
        && started.trim().chars().all(|c| c.is_ascii_digit())
        && elapsed.chars().all(|c| c.is_ascii_digit())
}

/// Where a shell keeps its history, relative to the user's home, and how
/// it is written. Ordered: the first that exists on disk wins.
#[cfg(windows)]
pub fn history_candidates() -> Vec<(&'static str, HistoryFormat)> {
    // PSReadLine's, under APPDATA rather than the profile root.
    vec![(
        "Microsoft/Windows/PowerShell/PSReadLine/ConsoleHost_history.txt",
        HistoryFormat::Plain,
    )]
}

#[cfg(not(windows))]
pub fn history_candidates() -> Vec<(&'static str, HistoryFormat)> {
    vec![
        (".zsh_history", HistoryFormat::ZshExtended),
        (".bash_history", HistoryFormat::Plain),
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_one_command_per_line() {
        let parsed = parse_history("npm test\ngit status\n", HistoryFormat::Plain);
        assert_eq!(parsed, vec!["npm test", "git status"]);
    }

    #[test]
    fn skips_blank_lines_and_trims() {
        let parsed = parse_history("  npm test  \n\n\n  \ncls\n", HistoryFormat::Plain);
        assert_eq!(parsed, vec!["npm test", "cls"]);
    }

    #[test]
    fn strips_the_zsh_timestamp_prefix() {
        let parsed = parse_history(
            ": 1699999999:0;git status\n: 1700000000:12;npm test\n",
            HistoryFormat::ZshExtended,
        );
        assert_eq!(parsed, vec!["git status", "npm test"]);
    }

    #[test]
    fn leaves_a_bare_command_alone_in_an_extended_file() {
        // zsh writes the prefix only under EXTENDED_HISTORY, and one file
        // can hold both shapes.
        let parsed = parse_history("git status\n: 1700000000:0;npm test\n", HistoryFormat::ZshExtended);
        assert_eq!(parsed, vec!["git status", "npm test"]);
    }

    #[test]
    fn does_not_mistake_a_command_starting_with_a_colon_for_a_stamp() {
        let parsed = parse_history(":wq\n:; echo hi\n", HistoryFormat::ZshExtended);
        assert_eq!(parsed, vec![":wq", ":; echo hi"]);
    }

    #[test]
    fn drops_multi_line_entries_rather_than_half_replaying_them() {
        let parsed = parse_history(
            "echo one \\\nand two\ngit status\n",
            HistoryFormat::Plain,
        );
        assert_eq!(parsed, vec!["git status"]);
    }

    #[test]
    fn keeps_the_newest_entries_when_the_file_is_long() {
        let text: String = (0..MAX_ENTRIES + 10).map(|n| format!("cmd{n}\n")).collect();
        let parsed = parse_history(&text, HistoryFormat::Plain);
        assert_eq!(parsed.len(), MAX_ENTRIES);
        assert_eq!(parsed[0], "cmd10");
        assert_eq!(parsed[MAX_ENTRIES - 1], format!("cmd{}", MAX_ENTRIES + 9));
    }
}
