//! The shell's history file, read for terminal suggestions.
//!
//! Read-only, on purpose. The shell writes this file itself — including
//! the commands typed in our terminal, since it is the same shell — so
//! keeping our own copy would buy nothing and give us a second thing to
//! get out of step. Locating and slurping is all that happens here; the
//! format lives in `agent_core::history`.

use std::fs;
use std::io::{Read, Seek, SeekFrom};
use std::path::PathBuf;

use agent_core::history::{history_candidates, parse_history};

/// Read at most this much, from the end. A history file grows without
/// bound and only its tail is still relevant; loading a 40 MB one to
/// throw away all but the last few thousand lines is work for nothing.
const MAX_TAIL_BYTES: u64 = 2 * 1024 * 1024;

/// The user's recent commands, oldest first. An unreadable or missing
/// file is not an error: suggestions simply start from nothing and fill
/// up as the user works.
#[tauri::command]
pub async fn shell_history() -> Result<Vec<String>, String> {
    crate::commands::run_blocking(|| Ok(read_history())).await
}

fn read_history() -> Vec<String> {
    let Some(home) = home_dir() else { return Vec::new() };
    for (relative, format) in history_candidates() {
        let path = home.join(relative);
        if let Some(text) = read_tail(&path) {
            return parse_history(&text, format);
        }
    }
    Vec::new()
}

/// Where the per-user files live. On Windows PSReadLine hangs off
/// APPDATA rather than the profile root, so that is the base there.
fn home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("APPDATA").map(PathBuf::from)
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// The last `MAX_TAIL_BYTES` of a file as text, or None if it cannot be
/// read. A tail can start mid-character and mid-line; the first partial
/// line is dropped, and the decode is lossy because a history file is
/// whatever the user's shell wrote, in whatever encoding it felt like.
fn read_tail(path: &std::path::Path) -> Option<String> {
    let mut file = fs::File::open(path).ok()?;
    let length = file.metadata().ok()?.len();
    let from = length.saturating_sub(MAX_TAIL_BYTES);
    if from > 0 {
        file.seek(SeekFrom::Start(from)).ok()?;
    }
    let mut bytes = Vec::new();
    file.take(MAX_TAIL_BYTES).read_to_end(&mut bytes).ok()?;
    let text = String::from_utf8_lossy(&bytes).into_owned();
    if from == 0 {
        return Some(text);
    }
    Some(match text.split_once('\n') {
        Some((_partial, rest)) => rest.to_owned(),
        None => text,
    })
}

#[cfg(test)]
mod tests {
    use agent_core::history::HistoryFormat;

    use super::*;

    #[test]
    fn reads_a_whole_short_file() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("history.txt");
        fs::write(&path, "npm test\ngit status\n").expect("write");
        assert_eq!(
            parse_history(&read_tail(&path).expect("read"), HistoryFormat::Plain),
            vec!["npm test", "git status"]
        );
    }

    #[test]
    fn drops_the_half_line_a_tail_starts_in_the_middle_of() {
        let dir = tempfile::tempdir().expect("temp dir");
        let path = dir.path().join("history.txt");
        let filler = "x".repeat(MAX_TAIL_BYTES as usize);
        fs::write(&path, format!("{filler}\nkept one\nkept two\n")).expect("write");
        let parsed = parse_history(&read_tail(&path).expect("read"), HistoryFormat::Plain);
        assert_eq!(parsed, vec!["kept one", "kept two"]);
    }

    #[test]
    fn a_missing_file_is_silence_rather_than_a_failure() {
        assert!(read_tail(std::path::Path::new("no/such/history.txt")).is_none());
    }
}
