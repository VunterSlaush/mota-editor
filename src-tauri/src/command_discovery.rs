//! Custom slash-command discovery — walks the well-known command folders
//! of each vendor CLI. Filesystem I/O lives here (shell layer); content
//! interpretation is delegated to `agent_core::commands`.

use std::fs;
use std::path::{Path, PathBuf};

use agent_core::commands::{
    command_name_from_file, content_hash, markdown_description, toml_description,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Whether a command file lives in the project's folder or the user's
/// home folder — the settings screen groups by this.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum CommandOrigin {
    Project,
    User,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CustomCommand {
    pub name: String,
    pub description: String,
    pub origin: CommandOrigin,
    /// Fingerprint of the file content, compared against the hash an
    /// approved optimization was made from to flag stale rows.
    pub content_hash: String,
}

/// Where a provider keeps custom commands, relative to project and home.
fn command_dirs(
    app: &AppHandle,
    project_path: &str,
    provider_id: &str,
) -> Vec<(PathBuf, CommandOrigin)> {
    let project = Path::new(project_path);
    let home = app.path().home_dir().ok();
    let mut dirs = Vec::new();
    match provider_id {
        "claude" => {
            dirs.push((project.join(".claude").join("commands"), CommandOrigin::Project));
            if let Some(home) = home {
                dirs.push((home.join(".claude").join("commands"), CommandOrigin::User));
            }
        }
        "codex" => {
            if let Some(home) = home {
                dirs.push((home.join(".codex").join("prompts"), CommandOrigin::User));
            }
        }
        "gemini" => {
            dirs.push((project.join(".gemini").join("commands"), CommandOrigin::Project));
            if let Some(home) = home {
                dirs.push((home.join(".gemini").join("commands"), CommandOrigin::User));
            }
        }
        _ => {}
    }
    dirs
}

/// Where a provider keeps skills (exposed as slash commands too).
fn skill_dirs(
    app: &AppHandle,
    project_path: &str,
    provider_id: &str,
) -> Vec<(PathBuf, CommandOrigin)> {
    if provider_id != "claude" {
        return Vec::new();
    }
    let mut dirs = vec![(
        Path::new(project_path).join(".claude").join("skills"),
        CommandOrigin::Project,
    )];
    if let Ok(home) = app.path().home_dir() {
        dirs.push((home.join(".claude").join("skills"), CommandOrigin::User));
    }
    dirs
}

pub fn discover(app: &AppHandle, project_path: &str, provider_id: &str) -> Vec<CustomCommand> {
    let mut commands: Vec<CustomCommand> = Vec::new();
    for (dir, origin) in command_dirs(app, project_path, provider_id) {
        if let Some(dir) = resolve_dir(dir) {
            collect_from_dir(&dir, origin, &mut commands);
        }
    }
    for (dir, origin) in skill_dirs(app, project_path, provider_id) {
        if let Some(dir) = resolve_dir(dir) {
            collect_skills(&dir, origin, &mut commands);
        }
    }
    commands.sort_by(|a, b| a.name.cmp(&b.name));
    // Stable sort + project dirs pushed before user dirs and commands
    // collected before skills: on a name clash the project command file
    // wins over the user's, and a command file over a same-named skill.
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

/// The commands folder an optimized copy of `name` belongs in: the
/// folder holding the source command file, or — for a skill — the
/// same-origin commands folder (which may not exist yet; the caller
/// creates it). None when the source is not a Markdown command: a
/// Gemini `.toml` cannot take a Markdown copy.
pub fn copy_target_dir(
    app: &AppHandle,
    project_path: &str,
    provider_id: &str,
    name: &str,
) -> Option<PathBuf> {
    for (dir, _) in command_dirs(app, project_path, provider_id) {
        let Some(resolved) = resolve_dir(dir) else { continue };
        let Ok(entries) = fs::read_dir(&resolved) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let named = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(command_name_from_file)
                .is_some_and(|n| n == name);
            if named && path.is_file() {
                let markdown =
                    path.extension().and_then(|e| e.to_str()).is_some_and(|e| e == "md");
                return markdown.then_some(resolved);
            }
        }
    }
    let folder = name.strip_prefix('/')?;
    if folder.is_empty() || folder.contains(['/', '\\']) || folder.contains("..") {
        return None;
    }
    for (dir, origin) in skill_dirs(app, project_path, provider_id) {
        let Some(resolved) = resolve_dir(dir) else { continue };
        if resolved.join(folder).join("SKILL.md").is_file() {
            return command_dirs(app, project_path, provider_id)
                .into_iter()
                .find(|(_, o)| *o == origin)
                .map(|(d, _)| d);
        }
    }
    None
}

fn collect_from_dir(dir: &Path, origin: CommandOrigin, commands: &mut Vec<CustomCommand>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        if let Some(command) = read_command(&path, origin) {
            commands.push(command);
        }
    }
}

/// Skills live one folder per skill, described by its `SKILL.md`.
fn collect_skills(dir: &Path, origin: CommandOrigin, commands: &mut Vec<CustomCommand>) {
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
            origin,
            content_hash: content_hash(&content),
        });
    }
}

fn read_command(path: &Path, origin: CommandOrigin) -> Option<CustomCommand> {
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
        origin,
        content_hash: content_hash(&content),
    })
}

/// The full text behind a slash command, resolved by name through the
/// same folders (and with the same precedence) as `discover`, so the
/// frontend never hands this layer a path.
pub fn find_command_body(app: &AppHandle, project_path: &str, provider_id: &str, name: &str) -> Option<String> {
    for (dir, _) in command_dirs(app, project_path, provider_id) {
        let Some(dir) = resolve_dir(dir) else { continue };
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            let is_named = path
                .file_name()
                .and_then(|n| n.to_str())
                .and_then(command_name_from_file)
                .is_some_and(|n| n == name);
            if is_named && path.is_file() {
                if let Ok(content) = fs::read_to_string(&path) {
                    return Some(content);
                }
            }
        }
    }
    // The folder name is joined into a path below; a name that is not a
    // plain path segment must not become a traversal.
    let folder = name.strip_prefix('/')?;
    if folder.is_empty() || folder.contains(['/', '\\']) || folder.contains("..") {
        return None;
    }
    for (dir, _) in skill_dirs(app, project_path, provider_id) {
        let Some(dir) = resolve_dir(dir) else { continue };
        if let Ok(content) = fs::read_to_string(dir.join(folder).join("SKILL.md")) {
            return Some(content);
        }
    }
    None
}
