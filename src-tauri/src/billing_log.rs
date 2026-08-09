//! I/O shell for [`agent_core::billing`] — finds the vendor's session
//! logs and feeds their lines to the pure parser.
//!
//! Only Claude Code is read: it writes billed usage to
//! `~/.claude/projects/<encoded-project>/<sessionId>.jsonl`, with any
//! subagent traffic under `<sessionId>/subagents/*.jsonl`. Other vendors'
//! log formats are undocumented, so their sessions keep the estimated
//! cost path rather than being guessed at.
//!
//! Security: these files contain the FULL text of every conversation.
//! Nothing here accepts a path from the caller and nothing but the typed
//! token counts of [`BilledRequest`] leaves this module — no prompt or
//! response text ever crosses the IPC boundary. Callers pass session
//! ids, which are only ever COMPARED against names found by walking the
//! directory; no path is built from caller input, so there is no
//! traversal to defend against.

use agent_core::billing::{dedupe_by_request_id, parse_billed_line, BilledRequest};
use std::collections::HashSet;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;
use tauri::{AppHandle, Manager};

use crate::commands::run_blocking;

/// Billed usage for the given provider session ids, deduped by request.
///
/// Returns empty rather than failing when the vendor's log directory is
/// absent or unreadable: ground truth is an upgrade over the estimate,
/// never a prerequisite, and a missing CLI must not break Insights.
#[tauri::command]
pub async fn read_billed_usage(
    app: AppHandle,
    session_ids: Vec<String>,
) -> Result<Vec<BilledRequest>, String> {
    run_blocking(move || {
        let wanted: HashSet<String> = session_ids.into_iter().collect();
        if wanted.is_empty() {
            return Ok(Vec::new());
        }
        let Ok(home) = app.path().home_dir() else {
            return Ok(Vec::new());
        };
        let root = home.join(".claude").join("projects");
        Ok(dedupe_by_request_id(collect_requests(&root, &wanted)))
    })
    .await
}

/// Every billed request across all project dirs for the wanted sessions.
///
/// The project directory name is deliberately not interpreted: its
/// encoding is lossy (`:` and `\` both become `-`) and its drive-letter
/// case varies by how the project was first opened, so reconstructing it
/// from a path silently misses sessions. The session id is the join key,
/// and it appears verbatim as a file (or directory) name.
fn collect_requests(root: &Path, wanted: &HashSet<String>) -> Vec<BilledRequest> {
    let Ok(project_dirs) = fs::read_dir(root) else {
        return Vec::new();
    };
    let mut requests = Vec::new();
    for project_dir in project_dirs.flatten() {
        let Ok(entries) = fs::read_dir(project_dir.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_dir() {
                // `<sessionId>/subagents/*.jsonl` — subagent traffic is
                // billed to the same account but appears in NO line of
                // the session's own file, so skipping these would
                // under-report a delegating session's real cost.
                if named_in(&path, wanted) {
                    collect_from_dir(&path, &mut requests);
                }
            } else if named_in(&path, wanted) {
                read_into(&path, &mut requests);
            }
        }
    }
    requests
}

/// Whether this entry's name (without a `.jsonl` suffix) is a session we
/// were asked about.
fn named_in(path: &Path, wanted: &HashSet<String>) -> bool {
    if path.is_file() && path.extension().and_then(OsStr::to_str) != Some("jsonl") {
        return false;
    }
    path.file_stem()
        .and_then(OsStr::to_str)
        .is_some_and(|name| wanted.contains(name))
}

/// Every `.jsonl` beneath a session's own directory.
fn collect_from_dir(dir: &Path, requests: &mut Vec<BilledRequest>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_from_dir(&path, requests);
        } else if path.extension().and_then(OsStr::to_str) == Some("jsonl") {
            read_into(&path, requests);
        }
    }
}

/// Parse one log file line by line. Streamed rather than read whole:
/// these files reach tens of megabytes, and all we keep is the counts.
fn read_into(path: &Path, requests: &mut Vec<BilledRequest>) {
    let Ok(file) = File::open(path) else {
        return;
    };
    let lines = BufReader::new(file).lines().map_while(Result::ok);
    requests.extend(lines.filter_map(|line| parse_billed_line(&line)));
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(session: &str, request: &str, output_tokens: u64) -> String {
        format!(
            r#"{{"type":"assistant","requestId":"{request}","sessionId":"{session}","isSidechain":false,"timestamp":"2026-08-09T13:09:43.642Z","message":{{"model":"claude-opus-5","usage":{{"input_tokens":1,"output_tokens":{output_tokens},"cache_read_input_tokens":0,"cache_creation_input_tokens":0}}}}}}"#
        )
    }

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().expect("has a parent")).expect("create dir");
        let mut file = File::create(path).expect("create file");
        writeln!(file, "{contents}").expect("write");
    }

    /// A vendor log tree: one project dir, one session, one subagent.
    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("G--some-project");
        write(&project.join("sess-1.jsonl"), &line("sess-1", "req_a", 10));
        write(
            &project
                .join("sess-1")
                .join("subagents")
                .join("agent-x.jsonl"),
            &line("sess-1", "req_sub", 7),
        );
        write(&project.join("sess-2.jsonl"), &line("sess-2", "req_b", 99));
        root
    }

    fn totals(root: &Path, wanted: &[&str]) -> u64 {
        let wanted: HashSet<String> = wanted.iter().map(|s| (*s).to_owned()).collect();
        dedupe_by_request_id(collect_requests(root, &wanted))
            .iter()
            .map(|r| r.output_tokens)
            .sum()
    }

    #[test]
    fn reads_only_the_sessions_asked_for() {
        let root = fixture();
        assert_eq!(totals(root.path(), &["sess-2"]), 99);
    }

    #[test]
    fn includes_subagent_traffic_the_session_file_never_records() {
        let root = fixture();
        // 10 from the session itself + 7 from the subagent it spawned.
        assert_eq!(totals(root.path(), &["sess-1"]), 17);
    }

    #[test]
    fn ignores_a_session_dir_whose_name_was_not_asked_for() {
        let root = fixture();
        assert_eq!(totals(root.path(), &["sess-3"]), 0);
    }

    #[test]
    fn is_empty_when_the_vendor_never_wrote_a_log() {
        let root = tempfile::tempdir().expect("temp dir");
        assert_eq!(totals(&root.path().join("absent"), &["sess-1"]), 0);
    }

    #[test]
    fn skips_files_that_are_not_logs() {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("G--some-project");
        write(&project.join("sess-1.txt"), &line("sess-1", "req_a", 10));
        assert_eq!(totals(root.path(), &["sess-1"]), 0);
    }
}
