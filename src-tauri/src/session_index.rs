//! I/O shell for [`agent_core::session_meta`] — lists the vendor's own
//! sessions for a project, so History can show conversations started
//! OUTSIDE this app (a terminal `claude`, another editor) without
//! booting an agent process just to ask.
//!
//! Only Claude Code is read: it shares one store with our ACP adapter at
//! `~/.claude/projects/<encoded-project>/<sessionId>.jsonl`. Other
//! vendors' stores are undocumented, so their history stays whatever the
//! live agent reports.
//!
//! Security: these files contain the FULL text of every conversation.
//! No caller path is ever joined into the walk — `project_path` is only
//! COMPARED against directory names and the `cwd` field found inside
//! files, so there is no traversal to defend against. Unlike
//! `billing_log.rs`, one deliberate sliver of text does cross the IPC
//! boundary here: the ≤80-character title snippet, which is the entire
//! point of a history row.

use agent_core::session_meta::{parse_session_head, same_project, MAX_HEAD_LINES};
use serde::Serialize;
use std::ffi::OsStr;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::Path;
use tauri::{AppHandle, Manager};

use crate::commands::run_blocking;

/// One externally stored session, metadata only — the conversation
/// itself is loaded through the agent (`load_agent_session`), never here.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalSessionMeta {
    pub session_id: String,
    /// First user message, or empty when the head held none — the
    /// frontend falls back to an id prefix, as it does for native rows.
    pub title: String,
    /// File mtime. The precise last-message timestamp lives at the TAIL
    /// of a multi-megabyte file; mtime orders a list without reading it.
    pub updated_at_ms: i64,
    pub size_bytes: u64,
}

/// The vendor's own sessions for this project, newest first.
///
/// Returns empty rather than failing when the store is absent or
/// unreadable: external history is an upgrade over the local list,
/// never a prerequisite, and a missing CLI must not break History.
#[tauri::command]
pub async fn list_external_sessions(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<ExternalSessionMeta>, String> {
    run_blocking(move || {
        let Ok(home) = app.path().home_dir() else {
            return Ok(Vec::new());
        };
        let root = home.join(".claude").join("projects");
        Ok(collect_external(&root, &project_path))
    })
    .await
}

/// Walk the store for sessions whose recorded cwd is this project.
///
/// The project directory name is only a pre-filter: its encoding is
/// lossy (`:` and `\` both become `-`) and its drive-letter case varies
/// by how the project was first opened, so two different projects can
/// share a name. The `cwd` field INSIDE each file is authoritative —
/// which also keeps worktrees apart, and drops foreign-shaped files
/// (they never yield a cwd) without knowing anything about them.
fn collect_external(root: &Path, project_path: &str) -> Vec<ExternalSessionMeta> {
    let Ok(project_dirs) = fs::read_dir(root) else {
        return Vec::new();
    };
    let encoded = encode_project_dir(project_path);
    let mut sessions = Vec::new();
    for project_dir in project_dirs.flatten() {
        if !dir_name_matches(&project_dir.path(), &encoded) {
            continue;
        }
        let Ok(entries) = fs::read_dir(project_dir.path()) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            // Directories are `<sessionId>/subagents/…` trees; the
            // session's own record is always the flat `.jsonl` file.
            if path.is_dir() || path.extension().and_then(OsStr::to_str) != Some("jsonl") {
                continue;
            }
            if let Some(meta) = read_session_meta(&path, project_path) {
                sessions.push(meta);
            }
        }
    }
    sessions.sort_by_key(|s| std::cmp::Reverse(s.updated_at_ms));
    sessions
}

/// Metadata from one log's head, or `None` when it isn't a session of
/// this project. Only the first [`MAX_HEAD_LINES`] lines are read —
/// these files reach tens of megabytes and a listing must stay instant.
fn read_session_meta(path: &Path, project_path: &str) -> Option<ExternalSessionMeta> {
    let file = File::open(path).ok()?;
    let lines = BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .take(MAX_HEAD_LINES);
    let head = parse_session_head(lines);
    if !head.cwd.is_some_and(|cwd| same_project(&cwd, project_path)) {
        return None;
    }
    // The file stem IS the session id everywhere else in this repo (it
    // is how billing joins too); the field inside merely confirms it.
    let session_id = path.file_stem().and_then(OsStr::to_str)?.to_owned();
    if head.session_id.is_some_and(|id| id != session_id) {
        return None;
    }
    let metadata = fs::metadata(path).ok()?;
    Some(ExternalSessionMeta {
        session_id,
        title: head.title.unwrap_or_default(),
        updated_at_ms: modified_ms(&metadata),
        size_bytes: metadata.len(),
    })
}

fn modified_ms(metadata: &fs::Metadata) -> i64 {
    metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(0))
}

/// The vendor's lossy directory encoding: every non-alphanumeric
/// character becomes `-`.
fn encode_project_dir(project_path: &str) -> String {
    project_path
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect()
}

fn dir_name_matches(dir: &Path, encoded: &str) -> bool {
    dir.file_name()
        .and_then(OsStr::to_str)
        .is_some_and(|name| name.eq_ignore_ascii_case(encoded))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn line(session: &str, cwd: &str, text: &str) -> String {
        let cwd = cwd.replace('\\', "\\\\");
        format!(
            r#"{{"type":"user","message":{{"role":"user","content":"{text}"}},"uuid":"u1","sessionId":"{session}","cwd":"{cwd}"}}"#
        )
    }

    fn write(path: &Path, contents: &str) {
        fs::create_dir_all(path.parent().expect("has a parent")).expect("create dir");
        let mut file = File::create(path).expect("create file");
        writeln!(file, "{contents}").expect("write");
    }

    /// A store with one matching project dir holding: a real session, a
    /// subagent tree, a stray text file, and a session of ANOTHER
    /// project that collides into the same lossy dir name.
    fn fixture() -> tempfile::TempDir {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("G--my-proj");
        write(
            &project.join("sess-1.jsonl"),
            &line("sess-1", "G:\\my\\proj", "fix the tests"),
        );
        write(
            &project.join("sess-1").join("subagents").join("a.jsonl"),
            &line("sess-1", "G:\\my\\proj", "subagent noise"),
        );
        write(
            &project.join("notes.txt"),
            &line("sess-x", "G:\\my\\proj", "not a log"),
        );
        // `G:\my\proj` and `G:\my-proj` encode to the same dir name.
        write(
            &project.join("sess-other.jsonl"),
            &line("sess-other", "G:\\my-proj", "different project"),
        );
        write(
            &root.path().join("C--elsewhere").join("sess-2.jsonl"),
            &line("sess-2", "C:\\elsewhere", "unrelated"),
        );
        root
    }

    fn ids(root: &Path, project_path: &str) -> Vec<String> {
        collect_external(root, project_path)
            .into_iter()
            .map(|s| s.session_id)
            .collect()
    }

    #[test]
    fn finds_only_this_projects_sessions_by_their_recorded_cwd() {
        let root = fixture();
        assert_eq!(ids(root.path(), "G:\\my\\proj"), vec!["sess-1"]);
    }

    #[test]
    fn excludes_a_lossy_dir_name_collision_from_another_project() {
        let root = fixture();
        assert_eq!(ids(root.path(), "G:\\my-proj"), vec!["sess-other"]);
    }

    #[test]
    fn carries_the_title_and_a_real_timestamp() {
        let root = fixture();
        let sessions = collect_external(root.path(), "G:\\my\\proj");
        assert_eq!(sessions[0].title, "fix the tests");
        assert!(sessions[0].updated_at_ms > 0);
        assert!(sessions[0].size_bytes > 0);
    }

    #[test]
    fn is_empty_when_the_vendor_never_wrote_a_store() {
        let root = tempfile::tempdir().expect("temp dir");
        assert_eq!(ids(&root.path().join("absent"), "G:\\my\\proj"), Vec::<String>::new());
    }

    #[test]
    fn drops_a_file_whose_inner_id_contradicts_its_name() {
        let root = tempfile::tempdir().expect("temp dir");
        let project = root.path().join("G--my-proj");
        write(
            &project.join("sess-renamed.jsonl"),
            &line("sess-original", "G:\\my\\proj", "moved file"),
        );
        assert_eq!(ids(root.path(), "G:\\my\\proj"), Vec::<String>::new());
    }
}
