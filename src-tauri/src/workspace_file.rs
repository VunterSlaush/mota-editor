//! Workspace persistence — one JSON file in the OS app-config directory.
//! The backend treats the payload as opaque; its shape is owned by the
//! frontend core (`PersistedWorkspace`).

use std::fs;
use std::io;
use std::path::PathBuf;

use tauri::{AppHandle, Manager};

const FILE_NAME: &str = "workspace.json";

fn workspace_path(app: &AppHandle) -> io::Result<PathBuf> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| io::Error::other(e.to_string()))?;
    fs::create_dir_all(&dir)?;
    Ok(dir.join(FILE_NAME))
}

pub fn load(app: &AppHandle) -> io::Result<Option<String>> {
    let path = workspace_path(app)?;
    match fs::read_to_string(path) {
        Ok(contents) => Ok(Some(contents)),
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e),
    }
}

pub fn save(app: &AppHandle, json: &str) -> io::Result<()> {
    let path = workspace_path(app)?;
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, json)?;
    fs::rename(&tmp, &path)?;
    Ok(())
}
