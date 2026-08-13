//! Session metadata, parsed from the head of a vendor session log.
//!
//! Claude Code and this app share one session store
//! (`~/.claude/projects/…/<sessionId>.jsonl`), so a session started in a
//! terminal can be listed and resumed here. All the history panel needs
//! is which project a file belongs to and what to call it — both live in
//! the first few lines, so a listing never reads a multi-megabyte log
//! past its head.
//!
//! Pure parsing only, per the Dependency Rule: finding and reading the
//! files is the shell's job (`session_index.rs` in the outer crate).

use serde_json::Value;

/// How many lines of a log are worth inspecting for metadata. The
/// session id and cwd are on the first real record; the title needs the
/// first USER message, which can sit behind a handful of queue and meta
/// records but never further than this.
pub const MAX_HEAD_LINES: usize = 40;

/// Longest title kept, in characters — a history row, not a transcript.
const MAX_TITLE_CHARS: usize = 80;

/// What the head of one session log revealed. Fields are independently
/// optional: a foreign-shaped file yields none of them and is dropped by
/// the shell, a session that never got a user message keeps its id.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct SessionHead {
    pub session_id: Option<String>,
    pub cwd: Option<String>,
    pub title: Option<String>,
}

impl SessionHead {
    fn is_complete(&self) -> bool {
        self.session_id.is_some() && self.cwd.is_some() && self.title.is_some()
    }
}

/// Fold up to [`MAX_HEAD_LINES`] log lines into a [`SessionHead`],
/// stopping early once every field is found. Never panics: these files
/// are written by another program and may gain fields or be half-flushed.
pub fn parse_session_head<I>(lines: I) -> SessionHead
where
    I: IntoIterator<Item = String>,
{
    let mut head = SessionHead::default();
    for line in lines.into_iter().take(MAX_HEAD_LINES) {
        let Ok(record) = serde_json::from_str::<Value>(line.trim()) else {
            continue;
        };
        if head.session_id.is_none() {
            head.session_id = non_empty_str(&record, "sessionId");
        }
        if head.cwd.is_none() {
            head.cwd = non_empty_str(&record, "cwd");
        }
        if head.title.is_none() {
            head.title = title_from(&record);
        }
        if head.is_complete() {
            break;
        }
    }
    head
}

/// Whether two paths name the same project directory. Slash direction,
/// a trailing slash, and letter case are all presentation: the vendor
/// records whatever cwd it was launched from, and on Windows the drive
/// letter's case varies by how the project was opened.
pub fn same_project(cwd: &str, project_path: &str) -> bool {
    let a = normalize_path(cwd);
    let b = normalize_path(project_path);
    !a.is_empty() && a == b
}

fn normalize_path(path: &str) -> String {
    path.trim()
        .replace('\\', "/")
        .trim_end_matches('/')
        .to_lowercase()
}

fn non_empty_str(record: &Value, key: &str) -> Option<String> {
    let value = record.get(key)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.to_owned())
}

/// The first USER message's text, when this record carries one — the
/// same source the app's own transcripts use for a title. Meta records
/// and command envelopes (`<command-name>…`, `<local-command-stdout>…`)
/// are the vendor talking to itself, not something to name a session by.
fn title_from(record: &Value) -> Option<String> {
    if record.get("type").and_then(Value::as_str) != Some("user") {
        return None;
    }
    if record.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let content = record.get("message")?.get("content")?;
    let text = match content {
        Value::String(text) => text.clone(),
        Value::Array(blocks) => blocks
            .iter()
            .find(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .and_then(|b| b.get("text"))
            .and_then(Value::as_str)?
            .to_owned(),
        _ => return None,
    };
    let text = text.trim();
    if text.is_empty() || text.starts_with('<') {
        return None;
    }
    Some(text.chars().take(MAX_TITLE_CHARS).collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn head(lines: &[&str]) -> SessionHead {
        parse_session_head(lines.iter().map(|l| (*l).to_owned()))
    }

    #[test]
    fn reads_id_cwd_and_title_from_a_plain_session() {
        let head = head(&[
            r#"{"type":"user","message":{"role":"user","content":"fix the flaky test"},"sessionId":"sess-1","cwd":"G:\\proj"}"#,
        ]);
        assert_eq!(head.session_id.as_deref(), Some("sess-1"));
        assert_eq!(head.cwd.as_deref(), Some("G:\\proj"));
        assert_eq!(head.title.as_deref(), Some("fix the flaky test"));
    }

    #[test]
    fn titles_from_block_array_content() {
        let head = head(&[
            r#"{"type":"user","message":{"role":"user","content":[{"type":"text","text":"hello there"}]},"sessionId":"s","cwd":"/p"}"#,
        ]);
        assert_eq!(head.title.as_deref(), Some("hello there"));
    }

    #[test]
    fn skips_command_envelopes_and_meta_lines_for_the_title() {
        let head = head(&[
            r#"{"type":"user","isMeta":true,"message":{"role":"user","content":"Caveat: ..."},"sessionId":"s","cwd":"/p"}"#,
            r#"{"type":"user","message":{"role":"user","content":"<command-name>/init</command-name>"},"sessionId":"s","cwd":"/p"}"#,
            r#"{"type":"user","message":{"role":"user","content":"the real question"},"sessionId":"s","cwd":"/p"}"#,
        ]);
        assert_eq!(head.title.as_deref(), Some("the real question"));
    }

    #[test]
    fn finds_fields_past_a_leading_queue_operation() {
        let head = head(&[
            r#"{"type":"queue-operation","operation":"enqueue","timestamp":"2026-08-06T14:22:13.740Z","sessionId":"sess-q"}"#,
            r#"{"type":"user","message":{"role":"user","content":"later line"},"sessionId":"sess-q","cwd":"/p"}"#,
        ]);
        assert_eq!(head.session_id.as_deref(), Some("sess-q"));
        assert_eq!(head.cwd.as_deref(), Some("/p"));
        assert_eq!(head.title.as_deref(), Some("later line"));
    }

    #[test]
    fn foreign_shapes_and_garbage_yield_an_empty_head() {
        let head = head(&[
            "not json at all",
            r#"{"event":"other-tool","data":{"path":"/x"}}"#,
            r#"[1,2,3]"#,
        ]);
        assert_eq!(head, SessionHead::default());
    }

    #[test]
    fn stops_reading_after_the_head_window() {
        let mut lines: Vec<String> = (0..MAX_HEAD_LINES).map(|_| "{}".to_owned()).collect();
        lines.push(
            r#"{"type":"user","message":{"role":"user","content":"too late"},"sessionId":"s","cwd":"/p"}"#
                .to_owned(),
        );
        assert_eq!(parse_session_head(lines), SessionHead::default());
    }

    #[test]
    fn truncates_the_title_to_a_row_sized_snippet() {
        let long = "x".repeat(200);
        let head = head(&[&format!(
            r#"{{"type":"user","message":{{"role":"user","content":"{long}"}},"sessionId":"s","cwd":"/p"}}"#
        )]);
        assert_eq!(head.title.map(|t| t.chars().count()), Some(80));
    }

    #[test]
    fn same_project_ignores_slash_direction_case_and_trailing_slash() {
        assert!(same_project("G:\\mota-editor", "g:/mota-editor/"));
        assert!(same_project("/home/u/proj", "/home/u/proj"));
        assert!(!same_project("G:\\mota-editor", "G:\\mota-editor-wks-1"));
        assert!(!same_project("", ""));
    }
}
