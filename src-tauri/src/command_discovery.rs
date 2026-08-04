//! Custom slash-command discovery — walks the well-known command folders
//! of each vendor CLI. Filesystem I/O lives here (shell layer); content
//! interpretation is delegated to `agent_core::commands`.

use std::fs;
use std::path::{Path, PathBuf};

use agent_core::commands::{command_name_from_file, markdown_description, toml_description};
use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommand {
    pub name: String,
    pub description: String,
}

/// Where a provider keeps custom commands, relative to project and home.
fn command_dirs(app: &AppHandle, project_path: &str, provider_id: &str) -> Vec<PathBuf> {
    let project = Path::new(project_path);
    let home = app.path().home_dir().ok();
    let mut dirs = Vec::new();
    match provider_id {
        "claude" => {
            dirs.push(project.join(".claude").join("commands"));
            if let Some(home) = home {
                dirs.push(home.join(".claude").join("commands"));
            }
        }
        "codex" => {
            if let Some(home) = home {
                dirs.push(home.join(".codex").join("prompts"));
            }
        }
        "gemini" => {
            dirs.push(project.join(".gemini").join("commands"));
            if let Some(home) = home {
                dirs.push(home.join(".gemini").join("commands"));
            }
        }
        _ => {}
    }
    dirs
}

pub fn discover(app: &AppHandle, project_path: &str, provider_id: &str) -> Vec<CustomCommand> {
    let mut commands: Vec<CustomCommand> = Vec::new();
    for dir in command_dirs(app, project_path, provider_id) {
        collect_from_dir(&dir, &mut commands);
    }
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    commands.dedup_by(|a, b| a.name == b.name);
    commands
}

fn collect_from_dir(dir: &Path, commands: &mut Vec<CustomCommand>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(command) = read_command(&path) {
            commands.push(command);
        }
    }
}

fn read_command(path: &Path) -> Option<CustomCommand> {
    let file_name = path.file_name()?.to_str()?;
    let extension = path.extension()?.to_str()?;
    let name = command_name_from_file(file_name)?;
    let content = fs::read_to_string(path).ok()?;
    let description = match extension {
        "md" => markdown_description(&content),
        "toml" => toml_description(&content),
        _ => return None,
    };
    Some(CustomCommand {
        name,
        description: description.unwrap_or_else(|| "Custom command".to_owned()),
    })
}
