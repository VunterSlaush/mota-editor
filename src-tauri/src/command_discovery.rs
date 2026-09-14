//! Custom slash-command discovery — walks the well-known command folders
//! of each vendor CLI. Filesystem I/O lives here (shell layer); content
//! interpretation is delegated to `agent_core::commands`.

use std::fs;
use std::path::{Path, PathBuf};

use agent_core::commands::{command_name_from_file, markdown_description, toml_description};
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
}

/// Where a provider keeps custom commands, relative to project and home.
fn command_dirs(
    home: Option<&Path>,
    project_path: &str,
    provider_id: &str,
) -> Vec<(PathBuf, CommandOrigin)> {
    let project = Path::new(project_path);
    let mut dirs = Vec::new();
    match provider_id {
        "claude" => {
            dirs.push((
                project.join(".claude").join("commands"),
                CommandOrigin::Project,
            ));
            if let Some(home) = home {
                dirs.push((home.join(".claude").join("commands"), CommandOrigin::User));
            }
        }
        "codex" => {
            dirs.push((
                project.join(".agents").join("commands"),
                CommandOrigin::Project,
            ));
            if let Some(home) = home {
                dirs.push((home.join(".codex").join("prompts"), CommandOrigin::User));
            }
        }
        "gemini" => {
            dirs.push((
                project.join(".gemini").join("commands"),
                CommandOrigin::Project,
            ));
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
    home: Option<&Path>,
    project_path: &str,
    provider_id: &str,
) -> Vec<(PathBuf, CommandOrigin)> {
    let folders: &[&str] = match provider_id {
        "claude" => &[".claude"],
        "codex" => &[".agents", ".codex"],
        _ => return Vec::new(),
    };
    let mut dirs = Vec::new();
    for folder in folders {
        dirs.push((
            Path::new(project_path).join(folder).join("skills"),
            CommandOrigin::Project,
        ));
    }
    if let Some(home) = home {
        for folder in folders {
            dirs.push((home.join(folder).join("skills"), CommandOrigin::User));
        }
    }
    dirs
}

pub fn discover(app: &AppHandle, project_path: &str, provider_id: &str) -> Vec<CustomCommand> {
    let mut commands: Vec<CustomCommand> = Vec::new();
    for (dir, origin) in command_dirs(
        app.path().home_dir().ok().as_deref(),
        project_path,
        provider_id,
    ) {
        if let Some(dir) = resolve_dir(dir) {
            collect_from_dir(&dir, origin, &mut commands);
        }
    }
    for (dir, origin) in skill_dirs(
        app.path().home_dir().ok().as_deref(),
        project_path,
        provider_id,
    ) {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codex_discovers_shared_project_commands_without_a_matching_skill() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let commands_dir = project.join(".agents").join("commands");
        fs::create_dir_all(&commands_dir).unwrap();
        for name in ["ship-it", "ticket"] {
            fs::write(
                commands_dir.join(format!("{name}.md")),
                "---\ndescription: Project workflow\n---\nFollow the project workflow.",
            )
            .unwrap();
        }
        let mut commands = Vec::new();
        for (dir, origin) in command_dirs(None, project.to_str().unwrap(), "codex") {
            if let Some(dir) = resolve_dir(dir) {
                collect_from_dir(&dir, origin, &mut commands);
            }
        }
        commands.sort_by(|a, b| a.name.cmp(&b.name));
        assert_eq!(
            commands.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(),
            ["/ship-it", "/ticket"]
        );
        assert!(commands
            .iter()
            .all(|c| c.origin == CommandOrigin::Project && c.description == "Project workflow"));
    }

    #[test]
    fn codex_discovers_project_and_user_skills() {
        let root = tempfile::tempdir().unwrap();
        let project = root.path().join("project");
        let home = root.path().join("home");
        for (base, folder, name) in [
            (&project, ".agents", "project-review"),
            (&project, ".codex", "project-check"),
            (&home, ".agents", "user-review"),
            (&home, ".codex", "user-check"),
        ] {
            let dir = base.join(folder).join("skills").join(name);
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("SKILL.md"),
                "---\ndescription: Review changes\n---",
            )
            .unwrap();
        }
        let mut commands = Vec::new();
        for (dir, origin) in skill_dirs(Some(&home), project.to_str().unwrap(), "codex") {
            collect_skills(&dir, origin, &mut commands);
        }
        assert_eq!(commands.len(), 4);
        assert!(commands
            .iter()
            .any(|c| c.name == "/project-review" && c.origin == CommandOrigin::Project));
        assert!(commands
            .iter()
            .any(|c| c.name == "/user-check" && c.origin == CommandOrigin::User));
    }
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

fn collect_from_dir(dir: &Path, origin: CommandOrigin, commands: &mut Vec<CustomCommand>) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
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
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let skill_dir = entry.path();
        let Some(name) = skill_dir
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::to_owned)
        else {
            continue;
        };
        let Ok(content) = fs::read_to_string(skill_dir.join("SKILL.md")) else {
            continue;
        };
        commands.push(CustomCommand {
            name: format!("/{name}"),
            description: markdown_description(&content)
                .unwrap_or_else(|| "Custom skill".to_owned()),
            origin,
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
    })
}
