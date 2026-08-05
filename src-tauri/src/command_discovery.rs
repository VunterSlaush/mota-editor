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

/// Where a provider keeps skills (exposed as slash commands too).
fn skill_dirs(app: &AppHandle, project_path: &str, provider_id: &str) -> Vec<PathBuf> {
    if provider_id != "claude" {
        return Vec::new();
    }
    let mut dirs = vec![Path::new(project_path).join(".claude").join("skills")];
    if let Ok(home) = app.path().home_dir() {
        dirs.push(home.join(".claude").join("skills"));
    }
    dirs
}

pub fn discover(app: &AppHandle, project_path: &str, provider_id: &str) -> Vec<CustomCommand> {
    let mut commands: Vec<CustomCommand> = Vec::new();
    for dir in command_dirs(app, project_path, provider_id) {
        if let Some(dir) = resolve_dir(dir) {
            collect_from_dir(&dir, &mut commands);
        }
    }
    for dir in skill_dirs(app, project_path, provider_id) {
        if let Some(dir) = resolve_dir(dir) {
            collect_skills(&dir, &mut commands);
        }
    }
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    // Stable sort + commands collected before skills: on a name clash
    // the command file wins over the same-named skill.
    commands.dedup_by(|a, b| a.name == b.name);
    commands
}

/// Follow a git "symlink" that Windows materialized as a plain text file
/// (checkouts with `core.symlinks=false`): the file's whole content is
/// the link target, relative to the file's own directory. Repos that
/// keep their agent config elsewhere and link `.claude/commands` to it
/// otherwise lose every command on Windows.
fn resolve_dir(path: PathBuf) -> Option<PathBuf> {
    if path.is_dir() {
        return Some(path);
    }
    let meta = fs::metadata(&path).ok()?;
    // A symlink target is one short path — anything else is not a link.
    if !meta.is_file() || meta.len() > 1024 {
        return None;
    }
    let target = fs::read_to_string(&path).ok()?;
    let target = target.trim();
    if target.is_empty() || target.contains('\n') || target.contains('\0') {
        return None;
    }
    let resolved = fs::canonicalize(path.parent()?.join(target)).ok()?;
    resolved.is_dir().then_some(resolved)
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

/// Skills live one folder per skill, described by its `SKILL.md`.
fn collect_skills(dir: &Path, commands: &mut Vec<CustomCommand>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let skill_dir = entry.path();
        let Some(name) = skill_dir.file_name().and_then(|n| n.to_str()).map(str::to_owned)
        else {
            continue;
        };
        let Ok(content) = fs::read_to_string(skill_dir.join("SKILL.md")) else { continue };
        commands.push(CustomCommand {
            name: format!("/{name}"),
            description: markdown_description(&content)
                .unwrap_or_else(|| "Custom skill".to_owned()),
        });
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
