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

fn sessions_dir(app: &AppHandle, project_path: &str) -> io::Result<PathBuf> {
    let mut hasher = DefaultHasher::new();
    project_path.hash(&mut hasher);
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| io::Error::other(e.to_string()))?
        .join("sessions")
        .join(format!("{:016x}", hasher.finish()));
    fs::create_dir_all(&dir)?;
    Ok(dir)
}

fn session_path(app: &AppHandle, project_path: &str, id: &str) -> io::Result<PathBuf> {
    let safe: String = id.chars().filter(|c| c.is_ascii_alphanumeric() || *c == '-').collect();
    Ok(sessions_dir(app, project_path)?.join(format!("{safe}.json")))
}

#[tauri::command]
pub fn save_session(
    app: AppHandle,
    project_path: String,
    id: String,
    json: String,
) -> Result<(), String> {
    let path = session_path(&app, &project_path, &id).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn list_sessions(app: AppHandle, project_path: String) -> Result<Vec<SessionMeta>, String> {
    let dir = sessions_dir(&app, &project_path).map_err(|e| e.to_string())?;
    let mut sessions: Vec<SessionMeta> = fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .filter_map(|entry| read_meta(&entry.path()))
        .collect();
    sessions.sort_by_key(|s| std::cmp::Reverse(s.saved_at));
    Ok(sessions)
}

#[tauri::command]
pub fn load_session(
    app: AppHandle,
    project_path: String,
    id: String,
) -> Result<Option<String>, String> {
    let path = session_path(&app, &project_path, &id).map_err(|e| e.to_string())?;
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn delete_session(app: AppHandle, project_path: String, id: String) -> Result<(), String> {
    let path = session_path(&app, &project_path, &id).map_err(|e| e.to_string())?;
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.to_string()),
    }
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
