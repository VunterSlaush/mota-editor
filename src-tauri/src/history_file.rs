//! Session-history persistence — one JSON file per conversation, in a
//! per-project folder under the app-config directory. The backend
//! treats each session payload as opaque except for the small metadata
//! header it lists; the schema is owned by the frontend core.

use std::collections::hash_map::DefaultHasher;
use std::fs;
use std::hash::{Hash, Hasher};
use std::io;
use std::path::PathBuf;

use serde::Serialize;
use serde_json::Value;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionMeta {
    pub id: String,
    pub title: String,
    pub saved_at: u64,
    pub provider: String,
    pub message_count: u64,
}

/// Stable directory name for a project's sessions. Also the reverse-map
/// key `list_session_stats` uses to attribute old transcripts (saved
/// before `projectPath` was embedded) back to a known project.
fn project_hash(project_path: &str) -> String {
    let mut hasher = DefaultHasher::new();
    project_path.hash(&mut hasher);
    format!("{:016x}", hasher.finish())
}

fn sessions_root(app: &AppHandle) -> io::Result<PathBuf> {
    Ok(app
        .path()
        .app_config_dir()
        .map_err(|e| io::Error::other(e.to_string()))?
        .join("sessions"))
}

fn sessions_dir(app: &AppHandle, project_path: &str) -> io::Result<PathBuf> {
    let dir = sessions_root(app)?.join(project_hash(project_path));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn session_path(app: &AppHandle, project_path: &str, id: &str) -> io::Result<PathBuf> {
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    Ok(sessions_dir(app, project_path)?.join(format!("{safe}.json")))
}

#[tauri::command]
pub async fn save_session(
    app: AppHandle,
    project_path: String,
    id: String,
    json: String,
) -> Result<(), String> {
    crate::commands::run_blocking(move || {
        let path = session_path(&app, &project_path, &id).map_err(|e| e.to_string())?;
        crate::workspace_file::write_atomic(&path, json.as_bytes()).map_err(|e| e.to_string())
    })
    .await
}

#[tauri::command]
pub async fn list_sessions(
    app: AppHandle,
    project_path: String,
) -> Result<Vec<SessionMeta>, String> {
    crate::commands::run_blocking(move || {
        let dir = sessions_dir(&app, &project_path).map_err(|e| e.to_string())?;
        let mut sessions: Vec<SessionMeta> = fs::read_dir(dir)
            .map_err(|e| e.to_string())?
            .flatten()
            .filter_map(|entry| read_meta(&entry.path()))
            .collect();
        sessions.sort_by_key(|s| std::cmp::Reverse(s.saved_at));
        Ok(sessions)
    })
    .await
}

#[tauri::command]
pub async fn load_session(
    app: AppHandle,
    project_path: String,
    id: String,
) -> Result<Option<String>, String> {
    crate::commands::run_blocking(move || {
        let path = session_path(&app, &project_path, &id).map_err(|e| e.to_string())?;
        match fs::read_to_string(path) {
            Ok(contents) => Ok(Some(contents)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
}

#[tauri::command]
pub async fn delete_session(
    app: AppHandle,
    project_path: String,
    id: String,
) -> Result<(), String> {
    crate::commands::run_blocking(move || {
        let path = session_path(&app, &project_path, &id).map_err(|e| e.to_string())?;
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    })
    .await
}

/// One prompt turn's stats, extracted from a persisted transcript.
/// Mirrors `TurnStat` in src/core/entities/insights.ts — Option fields
/// are omitted (not null) so the frontend sees plain `undefined`.
#[derive(Serialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TurnStat {
    pub sent_at: u64,
    pub mode: String,
    pub permission: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub effort: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub duration_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tokens_estimated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stop_reason: Option<String>,
    pub tool_counts: std::collections::HashMap<String, u32>,
}

/// One session file's stats. Mirrors `SessionStats` in insights.ts.
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct SessionStats {
    pub session_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub project_path: Option<String>,
    pub project_dir_hash: String,
    pub provider: String,
    pub saved_at: u64,
    pub turns: Vec<TurnStat>,
    pub touched_files: std::collections::HashMap<String, u32>,
}

/// Per-session stat rows across ALL project dirs under `sessions/`, for
/// the Insights view. `known_projects` are the open tabs' paths — their
/// hashes recover the project path for transcripts saved before
/// `projectPath` was embedded in the JSON.
#[tauri::command]
pub async fn list_session_stats(
    app: AppHandle,
    known_projects: Vec<String>,
) -> Result<Vec<SessionStats>, String> {
    crate::commands::run_blocking(move || {
        let root = sessions_root(&app).map_err(|e| e.to_string())?;
        let hash_to_path: std::collections::HashMap<String, String> = known_projects
            .into_iter()
            .map(|p| (project_hash(&p), p))
            .collect();
        let mut stats = Vec::new();
        let dirs = match fs::read_dir(&root) {
            Ok(dirs) => dirs,
            // No sessions saved yet — an empty report, not an error.
            Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(stats),
            Err(e) => return Err(e.to_string()),
        };
        for dir in dirs.flatten() {
            if !dir.path().is_dir() {
                continue;
            }
            let dir_hash = dir.file_name().to_string_lossy().into_owned();
            let known_path = hash_to_path.get(&dir_hash).cloned();
            let Ok(files) = fs::read_dir(dir.path()) else { continue };
            for file in files.flatten() {
                let path = file.path();
                if path.extension().and_then(|e| e.to_str()) != Some("json") {
                    continue;
                }
                let Ok(contents) = fs::read_to_string(&path) else { continue };
                let Ok(value) = serde_json::from_str::<Value>(&contents) else { continue };
                if let Some(mut s) = extract_stats(&dir_hash, &value) {
                    if s.project_path.is_none() {
                        s.project_path = known_path.clone();
                    }
                    stats.push(s);
                }
            }
        }
        Ok(stats)
    })
    .await
}

/// Mechanical field extraction from one transcript's JSON. Defensive:
/// malformed shapes yield `None` (skip the file) or drop the field,
/// never an error. The schema is owned by the frontend core.
fn extract_stats(dir_hash: &str, value: &Value) -> Option<SessionStats> {
    let session_id = value.get("id")?.as_str()?.to_owned();
    let mut turns: Vec<TurnStat> = Vec::new();
    let mut touched_files: std::collections::HashMap<String, u32> = Default::default();

    for message in value.get("messages").and_then(Value::as_array).unwrap_or(&Vec::new()) {
        let role = message.get("role").and_then(Value::as_str);
        if role == Some("user") {
            if let Some(turn) = message.get("turn").and_then(|t| extract_turn(t)) {
                turns.push(turn);
            }
            continue;
        }
        // Tool rows: count by kind on the turn they belong to, and tally
        // touched files session-wide. Legacy rows without `toolCall` and
        // tool rows preceding any turn (native-history rebuilds) are
        // counted into files only / skipped for turn attribution.
        let Some(tool_call) = message.get("toolCall") else { continue };
        if let Some(kind) = tool_call.get("toolKind").and_then(Value::as_str) {
            if let Some(turn) = turns.last_mut() {
                *turn.tool_counts.entry(kind.to_owned()).or_insert(0) += 1;
            }
        }
        for location in tool_call
            .get("locations")
            .and_then(Value::as_array)
            .unwrap_or(&Vec::new())
        {
            if let Some(file) = location.get("path").and_then(Value::as_str) {
                *touched_files.entry(file.to_owned()).or_insert(0) += 1;
            }
        }
    }

    Some(SessionStats {
        session_id,
        project_path: value
            .get("projectPath")
            .and_then(Value::as_str)
            .map(str::to_owned),
        project_dir_hash: dir_hash.to_owned(),
        provider: value
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("claude")
            .to_owned(),
        saved_at: value.get("savedAt").and_then(Value::as_u64).unwrap_or(0),
        turns,
        touched_files,
    })
}

fn extract_turn(turn: &Value) -> Option<TurnStat> {
    Some(TurnStat {
        sent_at: turn.get("sentAt").and_then(Value::as_u64)?,
        mode: turn
            .get("mode")
            .and_then(Value::as_str)
            .unwrap_or("normal")
            .to_owned(),
        permission: turn
            .get("permission")
            .and_then(Value::as_str)
            .unwrap_or("default")
            .to_owned(),
        model: turn.get("model").and_then(Value::as_str).map(str::to_owned),
        effort: turn.get("effort").and_then(Value::as_str).map(str::to_owned),
        command: turn.get("command").and_then(Value::as_str).map(str::to_owned),
        duration_ms: turn.get("durationMs").and_then(Value::as_u64),
        // Negative deltas (compaction) are dropped at save time, but old
        // files could carry them — treat them as unknown here too.
        tokens: turn.get("tokens").and_then(Value::as_i64).filter(|t| *t >= 0),
        tokens_estimated: turn
            .get("tokensEstimated")
            .and_then(Value::as_bool)
            .filter(|b| *b),
        stop_reason: turn
            .get("stopReason")
            .and_then(Value::as_str)
            .map(str::to_owned),
        tool_counts: Default::default(),
    })
}

fn read_meta(path: &std::path::Path) -> Option<SessionMeta> {
    if path.extension()?.to_str()? != "json" {
        return None;
    }
    let value: Value = serde_json::from_str(&fs::read_to_string(path).ok()?).ok()?;
    Some(SessionMeta {
        id: value.get("id")?.as_str()?.to_owned(),
        title: value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or("Untitled")
            .to_owned(),
        saved_at: value.get("savedAt").and_then(Value::as_u64).unwrap_or(0),
        provider: value
            .get("provider")
            .and_then(Value::as_str)
            .unwrap_or("claude")
            .to_owned(),
        message_count: value
            .get("messages")
            .and_then(Value::as_array)
            .map(|m| m.len() as u64)
            .unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn extracts_turn_fields_and_tool_attribution() {
        let value = json!({
            "id": "s1",
            "provider": "claude",
            "savedAt": 42,
            "projectPath": "/work/alpha",
            "messages": [
                { "role": "user", "text": "hi", "turn": {
                    "sentAt": 100, "mode": "plan", "permission": "default",
                    "model": "sonnet", "effort": "high", "command": "/review",
                    "durationMs": 5000, "tokens": 1200, "tokensEstimated": true,
                    "stopReason": "cancelled"
                }},
                { "role": "tool", "toolCall": {
                    "toolKind": "read", "status": "completed",
                    "locations": [{ "path": "src/a.ts" }, { "path": "src/b.ts" }]
                }},
                { "role": "tool", "toolCall": { "toolKind": "read", "locations": [] }},
                { "role": "assistant", "text": "done" }
            ]
        });
        let stats = extract_stats("deadbeef", &value).unwrap();
        assert_eq!(stats.session_id, "s1");
        assert_eq!(stats.project_path.as_deref(), Some("/work/alpha"));
        assert_eq!(stats.project_dir_hash, "deadbeef");
        assert_eq!(stats.saved_at, 42);
        assert_eq!(stats.turns.len(), 1);
        let turn = &stats.turns[0];
        assert_eq!(turn.sent_at, 100);
        assert_eq!(turn.mode, "plan");
        assert_eq!(turn.model.as_deref(), Some("sonnet"));
        assert_eq!(turn.command.as_deref(), Some("/review"));
        assert_eq!(turn.duration_ms, Some(5000));
        assert_eq!(turn.tokens, Some(1200));
        assert_eq!(turn.tokens_estimated, Some(true));
        assert_eq!(turn.stop_reason.as_deref(), Some("cancelled"));
        assert_eq!(turn.tool_counts.get("read"), Some(&2));
        assert_eq!(stats.touched_files.get("src/a.ts"), Some(&1));
        assert_eq!(stats.touched_files.get("src/b.ts"), Some(&1));
    }

    #[test]
    fn tool_rows_before_any_turn_count_files_but_no_turn() {
        let value = json!({
            "id": "s2",
            "messages": [
                { "role": "tool", "toolCall": {
                    "toolKind": "edit", "locations": [{ "path": "x.rs" }]
                }},
                { "role": "user", "text": "no turn meta here" }
            ]
        });
        let stats = extract_stats("h", &value).unwrap();
        assert!(stats.turns.is_empty());
        assert_eq!(stats.touched_files.get("x.rs"), Some(&1));
        // Missing provider defaults, missing projectPath stays None.
        assert_eq!(stats.provider, "claude");
        assert!(stats.project_path.is_none());
    }

    #[test]
    fn negative_tokens_and_missing_fields_are_dropped_not_errors() {
        let value = json!({
            "id": "s3",
            "messages": [
                { "role": "user", "turn": { "sentAt": 7, "tokens": -500 } },
                { "role": "user", "turn": { "mode": "normal" } }
            ]
        });
        let stats = extract_stats("h", &value).unwrap();
        // Second turn has no sentAt and is skipped entirely.
        assert_eq!(stats.turns.len(), 1);
        assert_eq!(stats.turns[0].tokens, None);
        assert_eq!(stats.turns[0].tokens_estimated, None);
        assert_eq!(stats.turns[0].mode, "normal");
    }

    #[test]
    fn files_without_id_are_skipped() {
        assert!(extract_stats("h", &json!({ "messages": [] })).is_none());
        assert!(extract_stats("h", &json!("not an object")).is_none());
    }

    #[test]
    fn project_hash_is_stable_and_hex() {
        let hash = project_hash("/work/alpha");
        assert_eq!(hash.len(), 16);
        assert_eq!(hash, project_hash("/work/alpha"));
        assert_ne!(hash, project_hash("/work/beta"));
    }
}
