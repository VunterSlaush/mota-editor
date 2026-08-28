//! Sub-agent discovery — walks the well-known agent folders of each
//! vendor CLI. Filesystem I/O lives here (shell layer); content
//! interpretation is delegated to `agent_core::commands`.
//!
//! Read-only by design. Mota never writes an agent definition: these
//! folders belong to the vendor and to the user, and a definition Mota
//! authored would keep working in their plain CLI sessions long after
//! Mota forgot about it.

use std::fs;
use std::path::{Path, PathBuf};

use agent_core::commands::{
    markdown_agent_name, markdown_description, toml_agent_name, toml_description,
};
use serde::Serialize;
use tauri::{AppHandle, Manager};

/// Whether a definition lives in the project's folder or the user's home
/// folder — the settings screen groups by this.
#[derive(Serialize, Clone, Copy, Debug, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum AgentOrigin {
    Project,
    User,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiscoveredAgent {
    pub name: String,
    pub description: String,
    pub origin: AgentOrigin,
}

/// How a provider stores its agent definitions. Claude and Gemini use
/// Markdown with YAML frontmatter; Codex uses TOML.
#[derive(Clone, Copy, PartialEq)]
enum Format {
    Markdown,
    Toml,
}

/// Where a provider keeps sub-agents, relative to project and home.
/// Project first so a project definition shadows a personal one.
fn agent_dirs(
    app: &AppHandle,
    project_path: &str,
    provider_id: &str,
) -> Vec<(PathBuf, AgentOrigin, Format)> {
    let project = Path::new(project_path);
    let home = app.path().home_dir().ok();
    let (vendor_dir, format) = match provider_id {
        "claude" => (".claude", Format::Markdown),
        "codex" => (".codex", Format::Toml),
        "gemini" => (".gemini", Format::Markdown),
        _ => return Vec::new(),
    };
    let mut dirs = vec![(project.join(vendor_dir).join("agents"), AgentOrigin::Project, format)];
    if let Some(home) = home {
        dirs.push((home.join(vendor_dir).join("agents"), AgentOrigin::User, format));
    }
    dirs
}

pub fn discover(app: &AppHandle, project_path: &str, provider_id: &str) -> Vec<DiscoveredAgent> {
    let mut agents: Vec<DiscoveredAgent> = Vec::new();
    for (dir, origin, format) in agent_dirs(app, project_path, provider_id) {
        if let Some(dir) = resolve_dir(dir) {
            collect_from_dir(&dir, origin, format, 0, &mut agents);
        }
    }
    agents.sort_by(|a, b| a.name.cmp(&b.name));
    // Stable sort + project dirs pushed before user dirs: on a name
    // clash the project definition wins, which is the same precedence
    // the vendors themselves apply.
    agents.dedup_by(|a, b| a.name == b.name);
    agents
}

/// Claude scans agent folders recursively, so `agents/review/foo.md` is
/// a real agent. Bounded because a symlinked or pathological tree must
/// not turn opening a settings screen into a full-disk walk.
const MAX_DEPTH: usize = 3;

/// Follow a git "symlink" that Windows materialized as a plain text file
/// (checkouts with `core.symlinks=false`): the file's whole content is
/// the link target, relative to the file's own directory. Same trick as
/// `command_discovery::resolve_dir`, and needed for the same reason —
/// repos that keep their agent config elsewhere would otherwise lose
/// every agent on Windows.
fn resolve_dir(path: PathBuf) -> Option<PathBuf> {
    if path.is_dir() {
        return Some(path);
    }
    let meta = fs::metadata(&path).ok()?;
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

fn collect_from_dir(
    dir: &Path,
    origin: AgentOrigin,
    format: Format,
    depth: usize,
    agents: &mut Vec<DiscoveredAgent>,
) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            if depth < MAX_DEPTH {
                collect_from_dir(&path, origin, format, depth + 1, agents);
            }
            continue;
        }
        if let Some(agent) = read_agent(&path, origin, format) {
            agents.push(agent);
        }
    }
}

fn read_agent(path: &Path, origin: AgentOrigin, format: Format) -> Option<DiscoveredAgent> {
    let extension = path.extension()?.to_str()?;
    let wanted = match format {
        Format::Markdown => "md",
        Format::Toml => "toml",
    };
    if extension != wanted {
        return None;
    }
    let content = fs::read_to_string(path).ok()?;
    let (name, description) = match format {
        Format::Markdown => (markdown_agent_name(&content), markdown_description(&content)),
        Format::Toml => (toml_agent_name(&content), toml_description(&content)),
    };
    // No declared name means no way to address it: the vendors resolve a
    // mention against the `name` field, not the file name.
    Some(DiscoveredAgent {
        name: name?,
        description: description.unwrap_or_else(|| "Custom sub-agent".to_owned()),
        origin,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn markdown(name: &str, description: &str) -> String {
        format!("---\nname: {name}\ndescription: {description}\n---\nBody text.\n")
    }

    #[test]
    fn reads_a_markdown_agent_by_its_declared_name() {
        let dir = tempdir();
        fs::write(dir.join("anything.md"), markdown("reviewer", "Reviews code")).unwrap();
        let mut found = Vec::new();
        collect_from_dir(&dir, AgentOrigin::User, Format::Markdown, 0, &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "reviewer");
        assert_eq!(found[0].description, "Reviews code");
    }

    #[test]
    fn reads_a_toml_agent() {
        let dir = tempdir();
        fs::write(dir.join("w.toml"), "name = \"worker\"\ndescription = \"Does work\"\n")
            .unwrap();
        let mut found = Vec::new();
        collect_from_dir(&dir, AgentOrigin::User, Format::Toml, 0, &mut found);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].name, "worker");
    }

    #[test]
    fn skips_a_definition_with_no_declared_name() {
        let dir = tempdir();
        fs::write(dir.join("nameless.md"), "---\ndescription: No name\n---\n").unwrap();
        let mut found = Vec::new();
        collect_from_dir(&dir, AgentOrigin::User, Format::Markdown, 0, &mut found);
        assert!(found.is_empty());
    }

    #[test]
    fn ignores_the_other_format() {
        let dir = tempdir();
        fs::write(dir.join("a.toml"), "name = \"x\"\n").unwrap();
        let mut found = Vec::new();
        collect_from_dir(&dir, AgentOrigin::User, Format::Markdown, 0, &mut found);
        assert!(found.is_empty());
    }

    #[test]
    fn descends_into_subfolders_but_not_forever() {
        let dir = tempdir();
        let nested = dir.join("review").join("deep");
        fs::create_dir_all(&nested).unwrap();
        fs::write(nested.join("a.md"), markdown("deep-agent", "Deep")).unwrap();
        let mut found = Vec::new();
        collect_from_dir(&dir, AgentOrigin::User, Format::Markdown, 0, &mut found);
        assert_eq!(found.len(), 1);

        let mut too_deep = Vec::new();
        collect_from_dir(&dir, AgentOrigin::User, Format::Markdown, MAX_DEPTH, &mut too_deep);
        assert!(too_deep.is_empty());
    }

    /// A unique scratch directory, removed by the OS eventually. The
    /// crate has no dev-dependency on `tempfile` and adding one for four
    /// tests is not worth it.
    fn tempdir() -> PathBuf {
        let base = std::env::temp_dir().join(format!(
            "mota-agent-discovery-{}-{:?}",
            std::process::id(),
            std::thread::current().id()
        ));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }
}
